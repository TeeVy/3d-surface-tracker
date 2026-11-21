/*  3D Surface Tracker — pont After Effects (AEGP).

    Donne au moteur de tracking les images d'un calque telles qu'elles arrivent à
    l'effet « 3D Surface Tracker », calculées par After Effects et envoyées
    directement en mémoire : pas de file d'attente de rendu, pas de fichiers.

    Un fil d'exécution écoute en TCP sur 127.0.0.1 (port choisi par le système). Le port
    et un jeton secret sont écrits dans un fichier lisible par l'utilisateur seul :
        macOS   ~/Library/Application Support/3D Surface Tracker/bridge.json
        Windows %APPDATA%\3D Surface Tracker\bridge.json
        {"port": 51234, "token": "…"}
    Le client envoie d'abord « AUTH <jeton> » ; ensuite, chaque requête est une ligne :
        PING
            -> "OK STBridge 4\n"
        RENDERL <id compo> <n° calque> <n° effet> <temps compo (valeur)> <(échelle)> <sous-éch.> <G|C>
            image du calque juste AVANT l'effet indiqué (effets au-dessus compris, numéros
            comptés à partir de 1 comme en ExtendScript), à un instant de la compo
            -> "OK <largeur> <hauteur> <canaux>\n" puis les pixels (1 octet par canal,
               lignes contiguës ; G : niveaux de gris, C : bleu-vert-rouge)
            -> "ERR <message>\n"
    Les appels à After Effects ne sont permis que sur le fil principal : les rendus
    sont faits dans le crochet « idle » d'AE, que le fil d'écoute réveille.
*/

#ifdef _WIN32
    #include <winsock2.h>  // avant windows.h (inclus par les en-têtes d'AE)
    #include <ws2tcpip.h>
#endif

#include "AEConfig.h"
#include "entry.h"
#include "AE_GeneralPlug.h"
#include "AE_Macros.h"
#include "AEGP_SuiteHandler.h"

#ifdef AE_OS_WIN
    typedef SOCKET sock_t;
    typedef int sockret_t;
    static const sock_t BAD_SOCK = INVALID_SOCKET;
    static void CloseSock(sock_t s) { closesocket(s); }
#else
    #include <arpa/inet.h>
    #include <netinet/in.h>
    #include <sys/socket.h>
    #include <unistd.h>
    typedef int sock_t;
    typedef ssize_t sockret_t;
    static const sock_t BAD_SOCK = -1;
    static void CloseSock(sock_t s) { close(s); }
#endif

#include <atomic>
#include <chrono>
#include <condition_variable>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <deque>
#include <filesystem>
#include <fstream>
#include <memory>
#include <mutex>
#include <random>
#include <sstream>
#include <string>
#include <thread>
#include <vector>

namespace fs = std::filesystem;

extern "C" DllExport AEGP_PluginInitFuncPrototype EntryPointFunc;

namespace {

AEGP_PluginID S_id = 0;
SPBasicSuite* S_sp = nullptr;
A_Err (*S_wake)(void) = nullptr;  // AEGP_CauseIdleRoutinesToBeCalled : appelable depuis n'importe quel fil

struct Request {
    A_long layer_index = 0, effect_index = 0;
    A_long item = 0;
    A_long tvalue = 0;
    A_u_long tscale = 1;
    A_short ds = 1;
    bool color = false;
    // réponse
    bool done = false;
    std::string error;
    A_long w = 0, h = 0;
    std::vector<unsigned char> pixels;
    std::mutex m;
    std::condition_variable cv;
};

std::mutex S_qm;
std::deque<std::shared_ptr<Request>> S_queue;
std::atomic<bool> S_quit{false};
sock_t S_listen = BAD_SOCK;
int S_port = 0;
std::string S_token;      // secret de cette instance d'AE (écrit dans bridge.json)
fs::path S_info_path;     // bridge.json

// ------------------------------------------------------------------ rendu (fil principal)
AEGP_ItemH FindItem(AEGP_SuiteHandler& suites, A_long wanted)
{
    AEGP_ProjectH projH = nullptr;
    AEGP_ItemH itemH = nullptr;
    if (suites.ProjSuite6()->AEGP_GetProjectByIndex(0, &projH) || !projH) return nullptr;
    if (suites.ItemSuite9()->AEGP_GetFirstProjItem(projH, &itemH)) return nullptr;
    while (itemH) {
        A_long id = 0;
        suites.ItemSuite9()->AEGP_GetItemID(itemH, &id);
        if (id == wanted) return itemH;
        AEGP_ItemH next = nullptr;
        if (suites.ItemSuite9()->AEGP_GetNextProjItem(projH, itemH, &next)) return nullptr;
        itemH = next;
    }
    return nullptr;
}

// Copie les pixels d'une image rendue (ARGB 8 bits) dans la réponse : gris ou BGR.
void Grab(AEGP_SuiteHandler& suites, AEGP_FrameReceiptH receiptH, Request& r)
{
    A_Err err = A_Err_NONE;
    AEGP_WorldH worldH = nullptr;
    ERR(suites.RenderSuite5()->AEGP_GetReceiptWorld(receiptH, &worldH));
    A_long w = 0, h = 0;
    A_u_long rowbytes = 0;
    PF_Pixel8* base = nullptr;
    ERR(suites.WorldSuite3()->AEGP_GetSize(worldH, &w, &h));
    ERR(suites.WorldSuite3()->AEGP_GetRowBytes(worldH, &rowbytes));
    ERR(suites.WorldSuite3()->AEGP_GetBaseAddr8(worldH, &base));
    if (err || !base || w <= 0 || h <= 0) { r.error = "unreadable rendered frame"; return; }
    const int ch = r.color ? 3 : 1;
    r.w = w;
    r.h = h;
    r.pixels.resize(static_cast<size_t>(w) * h * ch);
    unsigned char* out = r.pixels.data();
    for (A_long y = 0; y < h; y++) {
        const PF_Pixel8* p = reinterpret_cast<const PF_Pixel8*>(reinterpret_cast<const char*>(base) + y * rowbytes);
        if (r.color) {
            for (A_long x = 0; x < w; x++, out += 3) { out[0] = p[x].blue; out[1] = p[x].green; out[2] = p[x].red; }
        } else {
            for (A_long x = 0; x < w; x++) *out++ = static_cast<unsigned char>((77 * p[x].red + 150 * p[x].green + 29 * p[x].blue) >> 8);
        }
    }
}

// Calque juste avant un effet donné, à un instant de la compo.
void RenderLayer(AEGP_SuiteHandler& suites, Request& r)
{
    AEGP_ItemH itemH = FindItem(suites, r.item);
    if (!itemH) { r.error = "comp not found"; return; }
    A_Err err = A_Err_NONE, err2 = A_Err_NONE;
    AEGP_CompH compH = nullptr;
    AEGP_LayerH layerH = nullptr;
    AEGP_EffectRefH effectH = nullptr;
    AEGP_LayerRenderOptionsH lroH = nullptr;
    if (suites.CompSuite11()->AEGP_GetCompFromItem(itemH, &compH) || !compH) { r.error = "not a composition"; return; }
    if (suites.LayerSuite9()->AEGP_GetCompLayerByIndex(compH, r.layer_index - 1, &layerH) || !layerH) { r.error = "layer not found"; return; }
    if (suites.EffectSuite4()->AEGP_GetLayerEffectByIndex(S_id, layerH, r.effect_index - 1, &effectH) || !effectH) {
        r.error = "effect not found on the layer";
        return;
    }
    ERR(suites.LayerRenderOptionsSuite2()->AEGP_NewFromUpstreamOfEffect(S_id, effectH, &lroH));
    A_Time ct = {r.tvalue, r.tscale}, t = ct;
    if (!err) ERR(suites.LayerSuite9()->AEGP_ConvertCompToLayerTime(layerH, &ct, &t));
    if (!err && lroH) {
        ERR(suites.LayerRenderOptionsSuite2()->AEGP_SetTime(lroH, t));
        ERR(suites.LayerRenderOptionsSuite2()->AEGP_SetWorldType(lroH, AEGP_WorldType_8));
        ERR(suites.LayerRenderOptionsSuite2()->AEGP_SetDownsampleFactor(lroH, r.ds, r.ds));
        AEGP_FrameReceiptH receiptH = nullptr;
        if (!err) err = suites.RenderSuite5()->AEGP_RenderAndCheckoutLayerFrame(lroH, nullptr, nullptr, &receiptH);
        if (!err && receiptH) {
            Grab(suites, receiptH, r);
            ERR2(suites.RenderSuite5()->AEGP_CheckinFrame(receiptH));
        } else {
            r.error = "After Effects refused to render the layer (error " + std::to_string(err) + ")";
        }
    } else if (r.error.empty()) {
        r.error = "cannot create the layer render options";
    }
    if (lroH) ERR2(suites.LayerRenderOptionsSuite2()->AEGP_Dispose(lroH));
    ERR2(suites.EffectSuite4()->AEGP_DisposeEffect(effectH));
}

void EnsureInfoFile();

A_Err IdleHook(AEGP_GlobalRefcon, AEGP_IdleRefcon, A_long* max_sleepPL)
{
    EnsureInfoFile();
    AEGP_SuiteHandler suites(S_sp);
    const auto start = std::chrono::steady_clock::now();
    for (;;) {
        std::shared_ptr<Request> r;
        {
            std::lock_guard<std::mutex> lk(S_qm);
            if (S_queue.empty()) break;
            r = S_queue.front();
            S_queue.pop_front();
        }
        try {
            RenderLayer(suites, *r);
        } catch (...) {
            r->error = "exception while rendering";
        }
        {
            std::lock_guard<std::mutex> lk(r->m);
            r->done = true;
        }
        r->cv.notify_one();
        // garder AE réactif : on rend la main après ~40 ms, le reste au prochain passage
        if (std::chrono::steady_clock::now() - start > std::chrono::milliseconds(40)) break;
    }
    std::lock_guard<std::mutex> lk(S_qm);
    if (!S_queue.empty() && max_sleepPL) *max_sleepPL = 0;
    return A_Err_NONE;
}

// ------------------------------------------------------------------ réseau (fil d'écoute)
bool SendAll(sock_t fd, const void* data, size_t n)
{
    const char* p = static_cast<const char*>(data);
    while (n > 0) {
        const int chunk = static_cast<int>(n > (1u << 30) ? (1u << 30) : n);
        sockret_t k = send(fd, p, chunk, 0);
        if (k <= 0) return false;
        p += k;
        n -= static_cast<size_t>(k);
    }
    return true;
}

bool SendLine(sock_t fd, const std::string& s) { return SendAll(fd, s.data(), s.size()); }

// Ligne suivante (sans le \n) ; false si le client est parti.
bool ReadLine(sock_t fd, std::string& buf, std::string& line)
{
    char chunk[512];
    size_t nl;
    while ((nl = buf.find('\n')) == std::string::npos) {
        if (buf.size() > 4096) return false;  // pas une requête
        sockret_t k = recv(fd, chunk, sizeof(chunk), 0);
        if (k <= 0) return false;
        buf.append(chunk, static_cast<size_t>(k));
    }
    line = buf.substr(0, nl);
    if (!line.empty() && line.back() == '\r') line.pop_back();
    buf.erase(0, nl + 1);
    return true;
}

void Serve(sock_t fd)
{
    std::string buf, line;
    // premier message : le jeton (seuls les programmes qui peuvent lire bridge.json se connectent)
    if (!ReadLine(fd, buf, line) || line != "AUTH " + S_token) { CloseSock(fd); return; }
    while (!S_quit && ReadLine(fd, buf, line)) {
        if (line.rfind("PING", 0) == 0) {
            if (!SendLine(fd, "OK STBridge 4\n")) break;
            continue;
        }
        auto r = std::make_shared<Request>();
        long item = 0, tv = 0, ds = 1, li = 0, ei = 0;
        unsigned long ts = 1;
        char mode = 'G';
        bool ok = line.rfind("RENDERL", 0) == 0 &&
                  std::sscanf(line.c_str(), "RENDERL %ld %ld %ld %ld %lu %ld %c", &item, &li, &ei, &tv, &ts, &ds, &mode) >= 6 &&
                  li >= 1 && ei >= 1;
        if (!ok || ts == 0 || ds < 1) {
            if (!SendLine(fd, "ERR invalid request\n")) break;
            continue;
        }
        r->layer_index = static_cast<A_long>(li);
        r->effect_index = static_cast<A_long>(ei);
        r->item = static_cast<A_long>(item);
        r->tvalue = static_cast<A_long>(tv);
        r->tscale = static_cast<A_u_long>(ts);
        r->ds = static_cast<A_short>(ds);
        r->color = (mode == 'C');
        {
            std::lock_guard<std::mutex> lk(S_qm);
            S_queue.push_back(r);
        }
        if (S_wake) S_wake();
        {
            std::unique_lock<std::mutex> lk(r->m);
            while (!r->done && !S_quit) r->cv.wait_for(lk, std::chrono::milliseconds(200));
        }
        if (!r->done) break;
        if (!r->error.empty()) {
            if (!SendLine(fd, "ERR " + r->error + "\n")) break;
            continue;
        }
        char head[96];
        std::snprintf(head, sizeof(head), "OK %ld %ld %d\n", static_cast<long>(r->w), static_cast<long>(r->h), r->color ? 3 : 1);
        if (!SendLine(fd, head) || !SendAll(fd, r->pixels.data(), r->pixels.size())) break;
    }
    CloseSock(fd);
}

void Listen(sock_t lfd)
{
    while (!S_quit) {
        sock_t fd = accept(lfd, nullptr, nullptr);
        if (fd == BAD_SOCK) {
            if (S_quit) break;
            std::this_thread::sleep_for(std::chrono::milliseconds(100));
            continue;
        }
#ifdef SO_NOSIGPIPE
        int one = 1;
        setsockopt(fd, SOL_SOCKET, SO_NOSIGPIPE, &one, sizeof(one));  // client parti : pas de SIGPIPE
#endif
        std::thread(Serve, fd).detach();
    }
}

fs::path AppDir()
{
#ifdef AE_OS_WIN
    const char* base = std::getenv("APPDATA");
    return fs::path(base ? base : ".") / "3D Surface Tracker";
#else
    const char* home = std::getenv("HOME");
    return fs::path(home ? home : "/tmp") / "Library" / "Application Support" / "3D Surface Tracker";
#endif
}

std::string NewToken()
{
    std::random_device rd;
    std::ostringstream o;
    for (int i = 0; i < 4; i++) {
        char b[9];
        std::snprintf(b, sizeof(b), "%08x", static_cast<unsigned>(rd()));
        o << b;
    }
    return o.str();
}

std::string InfoText() { return "{\"port\": " + std::to_string(S_port) + ", \"token\": \"" + S_token + "\"}\n"; }

bool ReadFile(const fs::path& p, std::string& out)
{
    std::ifstream f(p, std::ios::binary);
    if (!f) return false;
    std::ostringstream o;
    o << f.rdbuf();
    out = o.str();
    return true;
}

// Écrit bridge.json (fichier temporaire puis renommage : jamais à moitié écrit).
bool WriteInfoFile()
{
    std::error_code ec;
    fs::create_directories(S_info_path.parent_path(), ec);
    fs::path tmp = S_info_path;
    tmp += ".tmp";
    {
        std::ofstream f(tmp, std::ios::binary | std::ios::trunc);
        if (!f) return false;
        f << InfoText();
    }
    fs::permissions(tmp, fs::perms::owner_read | fs::perms::owner_write, ec);  // utilisateur seul
    fs::rename(tmp, S_info_path, ec);
    return !ec;
}

// bridge.json a disparu (effacé par une autre instance d'AE qui se fermait, par exemple) :
// on le réécrit. Vérifié dans le crochet idle, toutes les 2 s au plus (un simple stat).
void EnsureInfoFile()
{
    static auto last = std::chrono::steady_clock::now();
    auto now = std::chrono::steady_clock::now();
    if (S_quit || S_port == 0 || now - last < std::chrono::seconds(2)) return;
    last = now;
    std::error_code ec;
    if (!fs::exists(S_info_path, ec)) WriteInfoFile();
}

bool StartServer()
{
#ifdef AE_OS_WIN
    WSADATA wsa;
    if (WSAStartup(MAKEWORD(2, 2), &wsa) != 0) return false;
#endif
    sock_t lfd = socket(AF_INET, SOCK_STREAM, IPPROTO_TCP);
    if (lfd == BAD_SOCK) return false;
    sockaddr_in addr{};
    addr.sin_family = AF_INET;
    addr.sin_addr.s_addr = htonl(INADDR_LOOPBACK);  // cette machine seulement
    addr.sin_port = 0;                               // port libre choisi par le système
    socklen_t len = sizeof(addr);
    if (bind(lfd, reinterpret_cast<sockaddr*>(&addr), sizeof(addr)) != 0 || listen(lfd, 8) != 0 ||
        getsockname(lfd, reinterpret_cast<sockaddr*>(&addr), &len) != 0) {
        CloseSock(lfd);
        return false;
    }
    S_listen = lfd;
    S_port = ntohs(addr.sin_port);
    S_token = NewToken();
    S_info_path = AppDir() / "bridge.json";
    std::thread(Listen, lfd).detach();
    return WriteInfoFile();
}

A_Err DeathHook(AEGP_GlobalRefcon, AEGP_DeathRefcon)
{
    S_quit = true;
    if (S_listen != BAD_SOCK) {
#ifdef AE_OS_WIN
        shutdown(S_listen, SD_BOTH);
#else
        shutdown(S_listen, SHUT_RDWR);
#endif
        CloseSock(S_listen);
        S_listen = BAD_SOCK;
    }
    // n'effacer bridge.json que s'il est le nôtre : une autre instance d'AE a pu écrire le sien
    std::string cur;
    std::error_code ec;
    if (!S_info_path.empty() && ReadFile(S_info_path, cur) && cur == InfoText()) fs::remove(S_info_path, ec);
    // requêtes en attente : on les libère avec une erreur
    std::lock_guard<std::mutex> lk(S_qm);
    for (auto& r : S_queue) {
        std::lock_guard<std::mutex> lr(r->m);
        r->error = "After Effects is quitting";
        r->done = true;
        r->cv.notify_one();
    }
    S_queue.clear();
    return A_Err_NONE;
}

}  // namespace

A_Err EntryPointFunc(struct SPBasicSuite* pica_basicP, A_long, A_long, AEGP_PluginID aegp_plugin_id,
                     AEGP_GlobalRefcon*)
{
    S_id = aegp_plugin_id;
    S_sp = pica_basicP;
    A_Err err = A_Err_NONE;
    AEGP_SuiteHandler suites(pica_basicP);
    S_wake = suites.UtilitySuite6()->AEGP_CauseIdleRoutinesToBeCalled;
    ERR(suites.RegisterSuite5()->AEGP_RegisterIdleHook(S_id, IdleHook, nullptr));
    ERR(suites.RegisterSuite5()->AEGP_RegisterDeathHook(S_id, DeathHook, nullptr));
    if (!err && !StartServer()) {
        suites.UtilitySuite6()->AEGP_ReportInfo(S_id, "3D Surface Tracker: cannot start the bridge (local connection).");
    }
    return err;
}
