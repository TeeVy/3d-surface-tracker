/*  3D Surface Tracker — pont After Effects (AEGP).

    Donne au moteur de tracking les images d'un calque telles qu'elles arrivent à
    l'effet « 3D Surface Tracker », calculées par After Effects et envoyées
    directement en mémoire : pas de file d'attente de rendu, pas de fichiers.

    Un fil d'exécution écoute sur une socket locale
        ~/Library/Application Support/3D Surface Tracker/bridge.sock
    Chaque requête est une ligne de texte :
        PING
            -> "OK STBridge 3\n"
        RENDERL <id compo> <n° calque> <n° effet> <temps compo (valeur)> <(échelle)> <sous-éch.> <G|C>
            image du calque juste AVANT l'effet indiqué (effets au-dessus compris, numéros
            comptés à partir de 1 comme en ExtendScript), à un instant de la compo
            -> "OK <largeur> <hauteur> <canaux>\n" puis les pixels (1 octet par canal,
               lignes contiguës ; G : niveaux de gris, C : bleu-vert-rouge)
            -> "ERR <message>\n"
    Les appels à After Effects ne sont permis que sur le fil principal : les rendus
    sont faits dans le crochet « idle » d'AE, que le fil d'écoute réveille.
*/

#include "AEConfig.h"
#include "entry.h"
#include "AE_GeneralPlug.h"
#include "AE_Macros.h"
#include "AEGP_SuiteHandler.h"

#include <sys/socket.h>
#include <sys/un.h>
#include <sys/stat.h>
#include <unistd.h>
#include <pwd.h>
#include <signal.h>

#include <atomic>
#include <chrono>
#include <condition_variable>
#include <cstdio>
#include <cstring>
#include <deque>
#include <memory>
#include <mutex>
#include <string>
#include <thread>
#include <vector>

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
int S_listen = -1;
std::string S_sock_path;

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
    if (err || !base || w <= 0 || h <= 0) { r.error = "image rendue illisible"; return; }
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
    if (!itemH) { r.error = "composition introuvable"; return; }
    A_Err err = A_Err_NONE, err2 = A_Err_NONE;
    AEGP_CompH compH = nullptr;
    AEGP_LayerH layerH = nullptr;
    AEGP_EffectRefH effectH = nullptr;
    AEGP_LayerRenderOptionsH lroH = nullptr;
    if (suites.CompSuite11()->AEGP_GetCompFromItem(itemH, &compH) || !compH) { r.error = "ce n'est pas une composition"; return; }
    if (suites.LayerSuite9()->AEGP_GetCompLayerByIndex(compH, r.layer_index - 1, &layerH) || !layerH) { r.error = "calque introuvable"; return; }
    if (suites.EffectSuite4()->AEGP_GetLayerEffectByIndex(S_id, layerH, r.effect_index - 1, &effectH) || !effectH) {
        r.error = "effet introuvable sur le calque";
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
            r.error = "rendu du calque refuse par After Effects (erreur " + std::to_string(err) + ")";
        }
    } else if (r.error.empty()) {
        r.error = "options de rendu du calque impossibles";
    }
    if (lroH) ERR2(suites.LayerRenderOptionsSuite2()->AEGP_Dispose(lroH));
    ERR2(suites.EffectSuite4()->AEGP_DisposeEffect(effectH));
}

A_Err IdleHook(AEGP_GlobalRefcon, AEGP_IdleRefcon, A_long* max_sleepPL)
{
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
            r->error = "exception pendant le rendu";
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

// ------------------------------------------------------------------ socket (fil d'écoute)
bool SendAll(int fd, const void* data, size_t n)
{
    const char* p = static_cast<const char*>(data);
    while (n > 0) {
        ssize_t k = send(fd, p, n, 0);
        if (k <= 0) return false;
        p += k;
        n -= static_cast<size_t>(k);
    }
    return true;
}

bool SendLine(int fd, const std::string& s) { return SendAll(fd, s.data(), s.size()); }

void Serve(int fd)
{
    std::string buf;
    char chunk[512];
    while (!S_quit) {
        size_t nl;
        while ((nl = buf.find('\n')) == std::string::npos) {
            ssize_t k = recv(fd, chunk, sizeof(chunk), 0);
            if (k <= 0) { close(fd); return; }
            buf.append(chunk, static_cast<size_t>(k));
        }
        std::string line = buf.substr(0, nl);
        buf.erase(0, nl + 1);
        if (line.rfind("PING", 0) == 0) {
            if (!SendLine(fd, "OK STBridge 3\n")) break;
            continue;
        }
        auto r = std::make_shared<Request>();
        long item = 0, tv = 0, ds = 1, li = 0, ei = 0;
        unsigned long ts = 1;
        char mode = 'G';
        bool ok = line.rfind("RENDERL", 0) == 0 &&
                  std::sscanf(line.c_str(), "RENDERL %ld %ld %ld %ld %lu %ld %c", &item, &li, &ei, &tv, &ts, &ds, &mode) >= 6 &&
                  li >= 1 && ei >= 1;
        r->layer_index = static_cast<A_long>(li);
        r->effect_index = static_cast<A_long>(ei);
        if (!ok || ts == 0 || ds < 1) {
            if (!SendLine(fd, "ERR requete invalide\n")) break;
            continue;
        }
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
    close(fd);
}

void Listen()
{
    while (!S_quit) {
        int fd = accept(S_listen, nullptr, nullptr);
        if (fd < 0) {
            if (S_quit) break;
            std::this_thread::sleep_for(std::chrono::milliseconds(100));
            continue;
        }
        int one = 1;
        setsockopt(fd, SOL_SOCKET, SO_NOSIGPIPE, &one, sizeof(one));  // client parti : pas de SIGPIPE
        std::thread(Serve, fd).detach();
    }
}

bool StartServer()
{
    const char* home = getenv("HOME");
    if (!home) {
        struct passwd* pw = getpwuid(getuid());
        home = pw ? pw->pw_dir : "/tmp";
    }
    std::string dir = std::string(home) + "/Library/Application Support/3D Surface Tracker";
    mkdir(dir.c_str(), 0755);
    S_sock_path = dir + "/bridge.sock";
    unlink(S_sock_path.c_str());
    S_listen = socket(AF_UNIX, SOCK_STREAM, 0);
    if (S_listen < 0) return false;
    sockaddr_un addr{};
    addr.sun_family = AF_UNIX;
    if (S_sock_path.size() >= sizeof(addr.sun_path)) return false;
    std::strncpy(addr.sun_path, S_sock_path.c_str(), sizeof(addr.sun_path) - 1);
    if (bind(S_listen, reinterpret_cast<sockaddr*>(&addr), sizeof(addr)) < 0) return false;
    chmod(S_sock_path.c_str(), 0600);  // seul l'utilisateur peut s'y connecter
    if (listen(S_listen, 8) < 0) return false;
    std::thread(Listen).detach();
    return true;
}

A_Err DeathHook(AEGP_GlobalRefcon, AEGP_DeathRefcon)
{
    S_quit = true;
    if (S_listen >= 0) {
        shutdown(S_listen, SHUT_RDWR);
        close(S_listen);
        S_listen = -1;
    }
    if (!S_sock_path.empty()) unlink(S_sock_path.c_str());
    // requêtes en attente : on les libère avec une erreur
    std::lock_guard<std::mutex> lk(S_qm);
    for (auto& r : S_queue) {
        std::lock_guard<std::mutex> lr(r->m);
        r->error = "After Effects se ferme";
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
        suites.UtilitySuite6()->AEGP_ReportInfo(S_id, "3D Surface Tracker : impossible d'ouvrir la socket du pont.");
    }
    return err;
}
