/*  3D Surface Tracker — effet.

    Placé en bas de la pile d'effets d'un calque, il ne modifie pas l'image.
    - « Ouvrir le tracker » : ouvre le panneau sur ce calque ; le panneau suit l'image telle
      qu'elle arrive à l'effet (effets placés au-dessus compris), via le pont STBridge.
    - « Afficher la grille » : grille 3D de la surface dans la fenêtre de composition quand
      l'effet est sélectionné.
    - « Données du tracking » : le panneau y écrit le résultat (« Appliquer le tracking ») et
      le relit en rouvrant le tracker. Seules la position et l'orientation sont animées (et le
      zoom si l'objectif zoome) ; le reste décrit la surface, la caméra, le mode et l'image de
      référence.
    - « Créer » : null, solide ou texte posé sur la surface (lié par expressions aux données :
      il suit un nouveau tracking appliqué), et la caméra si besoin.

    Unités : pixels de l'image du calque (avant sa mise à l'échelle dans la compo).
    Caméra : centrée sur l'image, à la distance « Distance caméra », zoom « Zoom caméra ».
*/

#include "AEConfig.h"
#include "entry.h"
#include "AE_Effect.h"
#include "AE_EffectCB.h"
#include "AE_EffectCBSuites.h"
#include "AE_EffectUI.h"
#include "AE_Macros.h"
#include "AE_GeneralPlug.h"
#include "AEGP_SuiteHandler.h"
#include "Param_Utils.h"

#include <algorithm>
#include <cmath>
#include <cstdio>
#include <string>
#include <utility>
#include <vector>

#define MAJOR_VERSION 1
#define MINOR_VERSION 5
#define BUG_VERSION 0
#define STAGE_VERSION PF_Stage_DEVELOP
#define BUILD_VERSION 1

enum {
    ST_INPUT = 0,
    ST_OPEN,
    ST_SHOW,
    ST_DATA_START,
    ST_POS_X, ST_POS_Y, ST_POS_Z,
    ST_ORI_X, ST_ORI_Y, ST_ORI_Z,
    ST_WIDTH, ST_HEIGHT,
    ST_ZOOM, ST_DIST,
    ST_SHAPE,
    ST_R_HG, ST_R_HD, ST_R_BD, ST_R_BG,
    ST_MODE, ST_REF, ST_KEYS,
    ST_CORR_START, ST_CORR, ST_CORR_END = ST_CORR + 8,
    ST_DATA_END,
    ST_NEW_START,
    ST_NEW_NULL, ST_NEW_SOLID, ST_NEW_TEXT,
    ST_NEW_END,
    ST_NUM_PARAMS
};

// identifiants disque : stables d'une version à l'autre (projets enregistrés)
enum {
    ID_OPEN = 1, ID_SHOW, ID_DATA_START,
    ID_POS_X, ID_POS_Y, ID_POS_Z, ID_ORI_X, ID_ORI_Y, ID_ORI_Z, ID_WIDTH, ID_HEIGHT, ID_ZOOM, ID_DIST,
    ID_SHAPE, ID_R_HG, ID_R_HD, ID_R_BD, ID_R_BG, ID_DATA_END,
    ID_NEW_START, ID_NEW_NULL, ID_NEW_SOLID, ID_NEW_TEXT, ID_NEW_END, ID_MODE, ID_REF, ID_KEYS, ID_CORR_START, ID_CORR_END,
    ID_CORR = 200
};

enum { SHAPE_RECT = 1, SHAPE_DISC };

extern "C" {
DllExport PF_Err EffectMain(PF_Cmd cmd, PF_InData* in_data, PF_OutData* out_data, PF_ParamDef* params[],
                            PF_LayerDef* output, void* extra);
}

namespace {

AEGP_PluginID S_aegp_id = 0;

PF_Err GlobalSetup(PF_InData* in_data, PF_OutData* out_data)
{
    out_data->my_version = PF_VERSION(MAJOR_VERSION, MINOR_VERSION, BUG_VERSION, STAGE_VERSION, BUILD_VERSION);
    // doivent correspondre aux drapeaux du PiPL (STEffect_PiPL.r)
    out_data->out_flags = PF_OutFlag_DEEP_COLOR_AWARE | PF_OutFlag_CUSTOM_UI;
    out_data->out_flags2 = PF_OutFlag2_SUPPORTS_THREADED_RENDERING;
    AEGP_SuiteHandler suites(in_data->pica_basicP);
    // identifiant AEGP : nécessaire pour exécuter un script depuis l'effet
    suites.UtilitySuite3()->AEGP_RegisterWithAEGP(nullptr, "3D Surface Tracker", &S_aegp_id);
    return PF_Err_NONE;
}

PF_Err AddSlider(PF_InData* in_data, const char* name, A_long id, PF_FpLong lo = -1000000, PF_FpLong hi = 1000000)
{
    PF_ParamDef def;
    AEFX_CLR_STRUCT(def);
    def.param_type = PF_Param_FLOAT_SLIDER;
    PF_STRNNCPY(def.PF_DEF_NAME, name, sizeof(def.PF_DEF_NAME));
    def.u.fs_d.valid_min = lo;
    def.u.fs_d.valid_max = hi;
    def.u.fs_d.slider_min = static_cast<PF_FpShort>(std::max<PF_FpLong>(lo, -10000));
    def.u.fs_d.slider_max = static_cast<PF_FpShort>(std::min<PF_FpLong>(hi, 10000));
    def.u.fs_d.value = def.u.fs_d.dephault = 0;
    def.u.fs_d.precision = 3;
    def.uu.id = id;
    return PF_ADD_PARAM(in_data, -1, &def);
}

PF_Err ParamsSetup(PF_InData* in_data, PF_OutData* out_data)
{
    PF_Err err = PF_Err_NONE;
    PF_ParamDef def;
    AEFX_CLR_STRUCT(def);
    PF_ADD_BUTTON("Tracker", "Ouvrir le tracker", 0, PF_ParamFlag_SUPERVISE, ID_OPEN);
    AEFX_CLR_STRUCT(def);
    PF_ADD_CHECKBOXX("Afficher la grille", TRUE, 0, ID_SHOW);

    AEFX_CLR_STRUCT(def);
    def.flags = PF_ParamFlag_START_COLLAPSED;
    PF_ADD_TOPIC("Données du tracking", ID_DATA_START);
    const char* names[] = {"Position X", "Position Y", "Position Z", "Orientation X", "Orientation Y", "Orientation Z",
                           "Largeur", "Hauteur", "Zoom caméra", "Distance caméra"};
    const A_long ids[] = {ID_POS_X, ID_POS_Y, ID_POS_Z, ID_ORI_X, ID_ORI_Y, ID_ORI_Z,
                          ID_WIDTH, ID_HEIGHT, ID_ZOOM, ID_DIST};
    for (int i = 0; i < 10 && !err; i++) err = AddSlider(in_data, names[i], ids[i]);
    if (err) return err;
    AEFX_CLR_STRUCT(def);
    PF_ADD_POPUP("Forme", 2, SHAPE_RECT, "Rectangle|Disque", ID_SHAPE);
    const char* rnames[] = {"Arrondi HG", "Arrondi HD", "Arrondi BD", "Arrondi BG"};
    const A_long rids[] = {ID_R_HG, ID_R_HD, ID_R_BD, ID_R_BG};
    for (int i = 0; i < 4 && !err; i++) err = AddSlider(in_data, rnames[i], rids[i], 0, 100);
    if (err) return err;
    // pour rouvrir le tracker sur ce tracking : mode et image de référence (n° d'image de la compo)
    AEFX_CLR_STRUCT(def);
    PF_ADD_POPUP("Mode", 2, 1, "3D|2D", ID_MODE);
    err = AddSlider(in_data, "Image de référence", ID_REF, 0, 1000000);
    if (err) return err;
    // une image clé AE par clé de correction posée dans le tracker (et sur la référence)
    AEFX_CLR_STRUCT(def);
    PF_ADD_CHECKBOXX("Clés de correction", FALSE, 0, ID_KEYS);
    // décalage des 4 coins (HG, HD, BD, BG) que chaque clé applique au suivi brut, aux images
    // des clés : permet de retrouver le suivi brut, et donc de retirer une clé, en rouvrant le tracker
    AEFX_CLR_STRUCT(def);
    def.flags = PF_ParamFlag_START_COLLAPSED;
    PF_ADD_TOPIC("Corrections", ID_CORR_START);
    const char* corners[] = {"HG", "HD", "BD", "BG"};
    for (int i = 0; i < 8 && !err; i++) {
        char name[32];
        std::snprintf(name, sizeof(name), "Correction %s %s", corners[i / 2], i % 2 ? "Y" : "X");
        err = AddSlider(in_data, name, ID_CORR + i);
    }
    if (err) return err;
    AEFX_CLR_STRUCT(def);
    PF_END_TOPIC(ID_CORR_END);
    AEFX_CLR_STRUCT(def);
    PF_END_TOPIC(ID_DATA_END);

    AEFX_CLR_STRUCT(def);
    PF_ADD_TOPIC("Créer", ID_NEW_START);
    AEFX_CLR_STRUCT(def);
    PF_ADD_BUTTON("Null", "Créer le null", 0, PF_ParamFlag_SUPERVISE, ID_NEW_NULL);
    AEFX_CLR_STRUCT(def);
    PF_ADD_BUTTON("Solide", "Créer le solide", 0, PF_ParamFlag_SUPERVISE, ID_NEW_SOLID);
    AEFX_CLR_STRUCT(def);
    PF_ADD_BUTTON("Texte", "Créer le texte", 0, PF_ParamFlag_SUPERVISE, ID_NEW_TEXT);
    AEFX_CLR_STRUCT(def);
    PF_END_TOPIC(ID_NEW_END);

    PF_CustomUIInfo ci;
    AEFX_CLR_STRUCT(ci);
    ci.events = PF_CustomEFlag_COMP | PF_CustomEFlag_LAYER;
    err = (*in_data->inter.register_ui)(in_data->effect_ref, &ci);
    out_data->num_params = ST_NUM_PARAMS;
    return err;
}

PF_Err Render(PF_InData* in_data, PF_LayerDef* output, PF_ParamDef* params[])
{
    // l'effet ne touche pas à l'image
    return PF_COPY(&params[ST_INPUT]->u.ld, output, nullptr, nullptr);
}

// ------------------------------------------------------------------ grille dans la compo
struct V3 { double x, y, z; };

struct Pose {
    double px, py, pz, R[9], w, h, zoom, dist, cx, cy;
    std::vector<double> poly;  // contour (u, v) 0..1 ; vide = rectangle simple
};

double Val(PF_ParamDef* p) { return p->u.fs_d.value; }

// Contour du rectangle arrondi dans le carré unité (même construction que le moteur et le
// panneau) : r = arrondi des coins HG, HD, BD, BG en 0..1.
void RoundedUnit(const double r[4], std::vector<double>& out)
{
    double rh = 0.5 * r[0], rd = 0.5 * r[1], rb = 0.5 * r[2], rg = 0.5 * r[3];
    const double arcs[4][4] = {{rd, 1 - rd, rd, -90}, {rb, 1 - rb, 1 - rb, 0}, {rg, rg, 1 - rg, 90}, {rh, rh, rh, 180}};
    for (const auto& a : arcs) {
        if (a[0] <= 1e-6) { out.push_back(a[1]); out.push_back(a[2]); continue; }
        for (int k = 0; k < 8; k++) {
            double t = (a[3] + 90.0 * k / 7) * M_PI / 180;
            out.push_back(a[1] + a[0] * cos(t));
            out.push_back(a[2] + a[0] * sin(t));
        }
    }
}

bool ReadPose(PF_InData* in_data, PF_ParamDef* params[], Pose& P)
{
    P.w = Val(params[ST_WIDTH]);
    P.h = Val(params[ST_HEIGHT]);
    P.dist = Val(params[ST_DIST]);
    P.zoom = Val(params[ST_ZOOM]);
    if (P.w <= 0 || P.h <= 0 || P.dist <= 0 || P.zoom <= 0) return false;  // rien d'appliqué
    // centre optique : centre de l'image du calque
    AEGP_SuiteHandler suites(in_data->pica_basicP);
    AEGP_LayerH layerH = nullptr;
    AEGP_ItemH itemH = nullptr;
    A_long iw = 0, ih = 0;
    if (suites.PFInterfaceSuite1()->AEGP_GetEffectLayer(in_data->effect_ref, &layerH) || !layerH ||
        suites.LayerSuite9()->AEGP_GetLayerSourceItem(layerH, &itemH) || !itemH ||
        suites.ItemSuite9()->AEGP_GetItemDimensions(itemH, &iw, &ih) || iw <= 0) {
        return false;
    }
    P.cx = iw / 2.0;
    P.cy = ih / 2.0;
    P.px = Val(params[ST_POS_X]);
    P.py = Val(params[ST_POS_Y]);
    P.pz = Val(params[ST_POS_Z]);
    const double d = M_PI / 180;
    double a = Val(params[ST_ORI_X]) * d, b = Val(params[ST_ORI_Y]) * d, c = Val(params[ST_ORI_Z]) * d;
    // orientation AE : R = Rx · Ry · Rz
    double ca = cos(a), sa = sin(a), cb = cos(b), sb = sin(b), cc = cos(c), sc = sin(c);
    double Rx[9] = {1, 0, 0, 0, ca, -sa, 0, sa, ca}, Ry[9] = {cb, 0, sb, 0, 1, 0, -sb, 0, cb};
    double Rz[9] = {cc, -sc, 0, sc, cc, 0, 0, 0, 1}, T[9];
    for (int i = 0; i < 3; i++)
        for (int j = 0; j < 3; j++) {
            T[3 * i + j] = 0;
            for (int k = 0; k < 3; k++) T[3 * i + j] += Rx[3 * i + k] * Ry[3 * k + j];
        }
    for (int i = 0; i < 3; i++)
        for (int j = 0; j < 3; j++) {
            P.R[3 * i + j] = 0;
            for (int k = 0; k < 3; k++) P.R[3 * i + j] += T[3 * i + k] * Rz[3 * k + j];
        }
    if (params[ST_SHAPE]->u.pd.value == SHAPE_DISC) {
        for (int i = 0; i < 48; i++) {
            double t = 2 * M_PI * i / 48;
            P.poly.push_back(0.5 + 0.5 * cos(t));
            P.poly.push_back(0.5 + 0.5 * sin(t));
        }
    } else {
        double r[4] = {Val(params[ST_R_HG]) / 100, Val(params[ST_R_HD]) / 100, Val(params[ST_R_BD]) / 100,
                       Val(params[ST_R_BG]) / 100};
        if (r[0] > 0 || r[1] > 0 || r[2] > 0 || r[3] > 0) RoundedUnit(r, P.poly);
    }
    return true;
}

// point (u, v) 0..1 de la surface (z : vers l'arrière-plan) -> 3D, repère de l'image
V3 Surf(const Pose& P, double u, double v, double z = 0)
{
    double x = (u - 0.5) * P.w, y = (v - 0.5) * P.h;
    return {P.px + P.R[0] * x + P.R[1] * y + P.R[2] * z, P.py + P.R[3] * x + P.R[4] * y + P.R[5] * z,
            P.pz + P.R[6] * x + P.R[7] * y + P.R[8] * z};
}

// caméra en (cx, cy, -dist), regardant vers +z, focale = zoom (pixels de l'image)
bool Project(const Pose& P, const V3& X, double& u, double& v)
{
    double z = X.z + P.dist;
    if (z <= 1e-6) return false;
    u = P.cx + P.zoom * (X.x - P.cx) / z;
    v = P.cy + P.zoom * (X.y - P.cy) / z;
    return true;
}

// Segments d'une ligne de la grille à l'intérieur du contour (coordonnées 0..1) : intersections
// de la droite avec les côtés, triées puis prises deux à deux.
void Clip(const std::vector<double>& poly, bool vertical, double c, std::vector<std::pair<double, double>>& out)
{
    out.clear();
    if (poly.size() < 6) { out.push_back({0, 1}); return; }
    std::vector<double> hits;
    size_t n = poly.size() / 2;
    for (size_t i = 0; i < n; i++) {
        double x0 = poly[2 * i], y0 = poly[2 * i + 1], x1 = poly[2 * ((i + 1) % n)], y1 = poly[2 * ((i + 1) % n) + 1];
        double a0 = vertical ? x0 : y0, a1 = vertical ? x1 : y1, b0 = vertical ? y0 : x0, b1 = vertical ? y1 : x1;
        if ((a0 <= c && a1 > c) || (a1 <= c && a0 > c)) hits.push_back(b0 + (c - a0) / (a1 - a0) * (b1 - b0));
    }
    std::sort(hits.begin(), hits.end());
    for (size_t i = 0; i + 1 < hits.size(); i += 2) out.push_back({hits[i], hits[i + 1]});
}

struct Drawer {
    PF_InData* in_data;
    PF_EventExtra* ev;
    AEGP_SuiteHandler& suites;
    DRAWBOT_SupplierRef supplier;
    DRAWBOT_SurfaceRef surface;
    const Pose& P;

    // pixels de l'image du calque -> pixels de la fenêtre
    void ToFrame(double u, double v, float& x, float& y)
    {
        PF_FixedPoint pt = {FLOAT2FIX(u), FLOAT2FIX(v)};
        if ((*ev->contextH)->w_type == PF_Window_COMP) {
            ev->cbs.layer_to_comp(ev->cbs.refcon, ev->contextH, in_data->current_time, in_data->time_scale, &pt);
        }
        ev->cbs.source_to_frame(ev->cbs.refcon, ev->contextH, &pt);
        x = static_cast<float>(FIX_2_FLOAT(pt.x));
        y = static_cast<float>(FIX_2_FLOAT(pt.y));
    }

    void Stroke(const std::vector<V3>& pts, bool closed, float r, float g, float b, float width)
    {
        if (pts.size() < 2) return;
        DRAWBOT_PathRef path = nullptr;
        DRAWBOT_PenRef pen = nullptr;
        DRAWBOT_ColorRGBA col = {r, g, b, 1.0f};
        if (suites.SupplierSuiteCurrent()->NewPath(supplier, &path) || !path) return;
        bool first = true;
        for (const V3& X : pts) {
            double u, v;
            float x, y;
            if (!Project(P, X, u, v)) { first = true; continue; }
            ToFrame(u, v, x, y);
            if (first) suites.PathSuiteCurrent()->MoveTo(path, x, y);
            else suites.PathSuiteCurrent()->LineTo(path, x, y);
            first = false;
        }
        if (closed) suites.PathSuiteCurrent()->Close(path);
        if (!suites.SupplierSuiteCurrent()->NewPen(supplier, &col, width, &pen) && pen) {
            suites.SurfaceSuiteCurrent()->StrokePath(surface, pen, path);
            suites.SupplierSuiteCurrent()->ReleaseObject(reinterpret_cast<DRAWBOT_ObjectRef>(pen));
        }
        suites.SupplierSuiteCurrent()->ReleaseObject(reinterpret_cast<DRAWBOT_ObjectRef>(path));
    }
};

PF_Err DrawOverlay(PF_InData* in_data, PF_ParamDef* params[], PF_EventExtra* ev)
{
    if (!params[ST_SHOW]->u.bd.value) return PF_Err_NONE;
    Pose P;
    if (!ReadPose(in_data, params, P)) return PF_Err_NONE;
    AEGP_SuiteHandler suites(in_data->pica_basicP);
    DRAWBOT_DrawRef drawing = nullptr;
    if (suites.EffectCustomUISuite1()->PF_GetDrawingReference(ev->contextH, &drawing) || !drawing) return PF_Err_NONE;
    DRAWBOT_SupplierRef supplier = nullptr;
    DRAWBOT_SurfaceRef surface = nullptr;
    suites.DrawbotSuiteCurrent()->GetSupplier(drawing, &supplier);
    suites.DrawbotSuiteCurrent()->GetSurface(drawing, &surface);
    if (!supplier || !surface) return PF_Err_NONE;
    Drawer D{in_data, ev, suites, supplier, surface, P};

    // grille 8 x 8, découpée à la forme
    std::vector<std::pair<double, double>> segs;
    for (int i = 0; i <= 8; i++) {
        double c = i / 8.0;
        for (int dir = 0; dir < 2; dir++) {
            Clip(P.poly, dir == 0, c, segs);
            for (auto& s : segs) {
                std::vector<V3> line;
                line.push_back(dir == 0 ? Surf(P, c, s.first) : Surf(P, s.first, c));
                line.push_back(dir == 0 ? Surf(P, c, s.second) : Surf(P, s.second, c));
                D.Stroke(line, false, 0.0f, 0.86f, 1.0f, 1.0f);
            }
        }
    }
    // contour
    std::vector<V3> edge;
    if (P.poly.size() >= 6) {
        for (size_t i = 0; i < P.poly.size() / 2; i++) edge.push_back(Surf(P, P.poly[2 * i], P.poly[2 * i + 1]));
    } else {
        edge = {Surf(P, 0, 0), Surf(P, 1, 0), Surf(P, 1, 1), Surf(P, 0, 1)};
    }
    D.Stroke(edge, true, 0.0f, 0.86f, 1.0f, 2.0f);
    // axes : X rouge, Y vert, Z bleu (vers la caméra)
    double L = 0.5 * std::min(P.w, P.h);
    V3 o = Surf(P, 0.5, 0.5);
    D.Stroke({o, Surf(P, 0.5 + L / P.w, 0.5)}, false, 1.0f, 0.3f, 0.3f, 2.5f);
    D.Stroke({o, Surf(P, 0.5, 0.5 + L / P.h)}, false, 0.24f, 0.88f, 0.48f, 2.5f);
    D.Stroke({o, Surf(P, 0.5, 0.5, -L)}, false, 0.29f, 0.64f, 1.0f, 2.5f);
    ev->evt_out_flags = PF_EO_HANDLED_EVENT;
    return PF_Err_NONE;
}

PF_Err HandleEvent(PF_InData* in_data, PF_ParamDef* params[], PF_EventExtra* ev)
{
    if (ev->e_type == PF_Event_DRAW &&
        ((*ev->contextH)->w_type == PF_Window_COMP || (*ev->contextH)->w_type == PF_Window_LAYER)) {
        return DrawOverlay(in_data, params, ev);
    }
    return PF_Err_NONE;
}

// ------------------------------------------------------------------ scripts (boutons)
void RunScript(PF_InData* in_data, const std::string& script)
{
    AEGP_SuiteHandler suites(in_data->pica_basicP);
    AEGP_MemHandle resultH = nullptr, errorH = nullptr;
    suites.UtilitySuite6()->AEGP_ExecuteScript(S_aegp_id, script.c_str(), FALSE, &resultH, &errorH);
    if (resultH) suites.MemorySuite1()->AEGP_FreeMemHandle(resultH);
    if (errorH) suites.MemorySuite1()->AEGP_FreeMemHandle(errorH);
}

// En-tête des scripts : compo et calque qui portent l'effet (numéros ExtendScript).
bool ScriptHead(PF_InData* in_data, std::string& head)
{
    AEGP_SuiteHandler suites(in_data->pica_basicP);
    AEGP_LayerH layerH = nullptr;
    AEGP_CompH compH = nullptr;
    AEGP_ItemH itemH = nullptr;
    A_long comp_id = 0, layer_index = 0;
    A_Err err = A_Err_NONE;
    ERR(suites.PFInterfaceSuite1()->AEGP_GetEffectLayer(in_data->effect_ref, &layerH));
    ERR(suites.LayerSuite9()->AEGP_GetLayerParentComp(layerH, &compH));
    ERR(suites.CompSuite11()->AEGP_GetItemFromComp(compH, &itemH));
    ERR(suites.ItemSuite9()->AEGP_GetItemID(itemH, &comp_id));
    ERR(suites.LayerSuite9()->AEGP_GetLayerIndex(layerH, &layer_index));
    if (err) return false;
    char buf[160];
    std::snprintf(buf, sizeof(buf), "var ST_COMP = %ld, ST_LAYER = %ld;\n", static_cast<long>(comp_id),
                  static_cast<long>(layer_index + 1));  // AEGP compte depuis 0, ExtendScript depuis 1
    head = buf;
    return true;
}

const char* OPEN_SCRIPT = R"JSX(
(function () {
    var TITLE = "3D Surface Tracker";
    var MENU = "3D Surface Tracker (panneau)";  // différent du nom de l'effet, sinon AE applique l'effet
    var comp = app.project.itemByID(ST_COMP);
    var dir = new Folder(Folder.userData.fsName + "/" + TITLE);
    if (!dir.exists) dir.create();
    var f = new File(dir.fsName + "/pending.json");
    f.encoding = "UTF-8";
    if (!f.open("w")) {
        alert(TITLE + "\n\nActivez : Préférences > Scripts et expressions > « Autoriser les scripts à écrire des fichiers et à accéder au réseau ».");
        return;
    }
    f.write('{"compId":' + ST_COMP + ',"layerIndex":' + ST_LAYER + ',"time":' + comp.time + ',"stamp":' + new Date().getTime() + '}');
    f.close();
    var alive = new File(dir.fsName + "/alive.txt"), isOpen = false;
    if (alive.exists && alive.open("r")) {
        isOpen = (new Date().getTime() - parseFloat(alive.read())) < 3000;
        alive.close();
    }
    if (!isOpen) {
        var id = app.findMenuCommandId(MENU);
        if (id) app.executeCommand(id);
        else alert(TITLE + "\n\nOuvrez le panneau : Fenêtre > Extensions > " + MENU + ".");
    }
})();
)JSX";

// Crée un calque posé sur la surface : ST_KIND = "null" | "solid" | "text".
// roundedShape : même fonction que ROUNDED_SHAPE_JS dans surftrack/ae_export.py.
const char* CREATE_SCRIPT = R"JSX(
(function () {
    var TITLE = "3D Surface Tracker";
    var comp = app.project.itemByID(ST_COMP);
    if (!comp) return;
    var L = comp.layer(ST_LAYER), fx = null, par = L.property("ADBE Effect Parade");
    for (var i = 1; i <= par.numProperties; i++) if (par.property(i).matchName === "SurfTrack 3D Surface Tracker") { fx = par.property(i); break; }
    if (!fx) return;
    function v(name) { return fx.property(name).valueAtTime(comp.time, false); }
    function q(s) { return '"' + String(s).replace(/\\/g, "\\\\").replace(/"/g, '\\"') + '"'; }
    function roundedShape(w, h, r) {
        var K = 0.5523, vs = [], it = [], ot = [], any = false;
        var C = [[0, 0, [0, 1], [1, 0]], [w, 0, [-1, 0], [0, 1]], [w, h, [0, -1], [-1, 0]], [0, h, [1, 0], [0, -1]]];
        for (var i = 0; i < 4; i++) {
            var rx = 0.5 * Math.max(0, Math.min(1, r[i])) * w, ry = 0.5 * Math.max(0, Math.min(1, r[i])) * h;
            var c = C[i], a = c[2], b = c[3];
            if (rx < 1e-3 || ry < 1e-3) { vs.push([c[0], c[1]]); it.push([0, 0]); ot.push([0, 0]); continue; }
            any = true;
            var ra = a[0] ? rx : ry, rb = b[0] ? rx : ry;
            vs.push([c[0] + a[0] * ra, c[1] + a[1] * ra]); it.push([0, 0]); ot.push([-a[0] * K * ra, -a[1] * K * ra]);
            vs.push([c[0] + b[0] * rb, c[1] + b[1] * rb]); it.push([-b[0] * K * rb, -b[1] * K * rb]); ot.push([0, 0]);
        }
        if (!any) return null;
        var s = new Shape();
        s.vertices = vs; s.inTangents = it; s.outTangents = ot; s.closed = true;
        return s;
    }
    if (v("Largeur") <= 0) {
        alert(TITLE + "\n\nAucun tracking appliqué : ouvrez le tracker, trackez, puis « Appliquer le tracking ».");
        return;
    }
    var k = comp.width / L.width;
    var base = "ST " + L.name;
    // références aux données de l'effet (AE met à jour les noms dans les expressions s'ils changent)
    var ref = "var L = thisComp.layer(" + q(L.name) + "), e = L.effect(" + q(fx.name) + ");\n" +
              "var k = thisComp.width / L.width;\n";
    app.beginUndoGroup("3D Surface Tracker : créer un calque");

    // caméra (une par calque tracké), fixe ; zoom lié aux données
    var cam = null;
    for (var c = 1; c <= comp.numLayers; c++) if (comp.layer(c) instanceof CameraLayer && comp.layer(c).name === base + " Caméra") cam = comp.layer(c);
    if (!cam) {
        cam = comp.layers.addCamera(base + " Caméra", [comp.width / 2, comp.height / 2]);
        cam.autoOrient = AutoOrientType.NO_AUTO_ORIENT;
        var ct = cam.property("ADBE Transform Group");
        ct.property("ADBE Position").expression = ref + "[thisComp.width / 2, thisComp.height / 2, -e(\"Distance caméra\") * k]";
        ct.property("ADBE Orientation").setValue([0, 0, 0]);
        cam.property("ADBE Camera Options Group").property("ADBE Camera Zoom").expression = ref + "e(\"Zoom caméra\") * k";
    }

    var w = Math.max(4, Math.round(v("Largeur") * k)), h = Math.max(4, Math.round(v("Hauteur") * k));
    var lay;
    if (ST_KIND === "null") {
        lay = comp.layers.addNull();
        lay.name = base + " Surface";
        lay.property("ADBE Transform Group").property("ADBE Anchor Point").setValue([0, 0, 0]);
    } else if (ST_KIND === "solid") {
        lay = comp.layers.addSolid([0.15, 0.55, 1.0], base + " Solide", w, h, comp.pixelAspect);
        lay.property("ADBE Transform Group").property("ADBE Opacity").setValue(60);
        var r = fx.property("Forme").value === 2 ? [1, 1, 1, 1]
            : [v("Arrondi HG") / 100, v("Arrondi HD") / 100, v("Arrondi BD") / 100, v("Arrondi BG") / 100];
        var sh = roundedShape(w, h, r);
        if (sh) lay.property("ADBE Mask Parade").addProperty("ADBE Mask Atom").property("ADBE Mask Shape").setValue(sh);
    } else {
        lay = comp.layers.addText("Texte");
        lay.name = base + " Texte";
        var tp = lay.property("ADBE Text Properties").property("ADBE Text Document"), td = tp.value;
        td.fontSize = Math.max(6, Math.round(0.22 * Math.min(w, h)));
        td.fillColor = [1, 1, 1];
        td.justification = ParagraphJustification.CENTER_JUSTIFY;
        tp.setValue(td);
        var b = lay.sourceRectAtTime(comp.time, false);
        lay.property("ADBE Transform Group").property("ADBE Anchor Point").setValue([b.left + b.width / 2, b.top + b.height / 2, 0]);
    }
    lay.threeDLayer = true;
    var T = lay.property("ADBE Transform Group");
    T.property("ADBE Position").expression = ref + "[e(\"Position X\"), e(\"Position Y\"), e(\"Position Z\")] * k";
    T.property("ADBE Orientation").expression = ref + "[e(\"Orientation X\"), e(\"Orientation Y\"), e(\"Orientation Z\")]";
    if (ST_KIND === "solid") T.property("ADBE Scale").setValue([100 * v("Largeur") * k / w, 100 * v("Hauteur") * k / h, 100]);
    lay.moveBefore(L);
    app.endUndoGroup();
})();
)JSX";

PF_Err OnButton(PF_InData* in_data, int index)
{
    std::string head;
    if (!ScriptHead(in_data, head)) return PF_Err_NONE;
    if (index == ST_OPEN) {
        RunScript(in_data, head + OPEN_SCRIPT);
    } else {
        const char* kind = index == ST_NEW_NULL ? "null" : index == ST_NEW_SOLID ? "solid" : "text";
        RunScript(in_data, head + "var ST_KIND = \"" + kind + "\";\n" + CREATE_SCRIPT);
    }
    return PF_Err_NONE;
}

}  // namespace

extern "C" DllExport PF_Err PluginDataEntryFunction2(PF_PluginDataPtr inPtr, PF_PluginDataCB2 inPluginDataCallBackPtr,
                                                      SPBasicSuite* inSPBasicSuitePtr, const char* inHostName,
                                                      const char* inHostVersion)
{
    PF_Err result = PF_Err_INVALID_CALLBACK;
    result = PF_REGISTER_EFFECT_EXT2(inPtr, inPluginDataCallBackPtr, "3D Surface Tracker", "SurfTrack 3D Surface Tracker",
                                     "3D Surface Tracker", AE_RESERVED_INFO, "EffectMain", "https://github.com");
    return result;
}

PF_Err EffectMain(PF_Cmd cmd, PF_InData* in_data, PF_OutData* out_data, PF_ParamDef* params[], PF_LayerDef* output,
                  void* extra)
{
    PF_Err err = PF_Err_NONE;
    try {
        switch (cmd) {
            case PF_Cmd_ABOUT:
                PF_SPRINTF(out_data->return_msg, "3D Surface Tracker\rMarque le calque à tracker et ouvre le panneau.");
                break;
            case PF_Cmd_GLOBAL_SETUP:
                err = GlobalSetup(in_data, out_data);
                break;
            case PF_Cmd_PARAMS_SETUP:
                err = ParamsSetup(in_data, out_data);
                break;
            case PF_Cmd_RENDER:
                err = Render(in_data, output, params);
                break;
            case PF_Cmd_EVENT:
                err = HandleEvent(in_data, params, reinterpret_cast<PF_EventExtra*>(extra));
                break;
            case PF_Cmd_USER_CHANGED_PARAM: {
                const PF_UserChangedParamExtra* ch = reinterpret_cast<const PF_UserChangedParamExtra*>(extra);
                if (ch && (ch->param_index == ST_OPEN || ch->param_index == ST_NEW_NULL ||
                           ch->param_index == ST_NEW_SOLID || ch->param_index == ST_NEW_TEXT)) {
                    err = OnButton(in_data, ch->param_index);
                }
                break;
            }
            default:
                break;
        }
    } catch (PF_Err& thrown) {
        err = thrown;
    } catch (...) {
        err = PF_Err_INTERNAL_STRUCT_DAMAGED;
    }
    return err;
}
