/*  3D Surface Tracker — effet.

    Placé en bas de la pile d'effets d'un calque, il ne modifie pas l'image.
    - « Ouvrir le tracker » : ouvre le panneau sur ce calque ; le panneau suit l'image telle
      qu'elle arrive à l'effet (effets placés au-dessus compris), via le pont STBridge.
    - Le panneau écrit le résultat (« Appliquer le tracking ») en images clés sur les
      paramètres du groupe « Données du tracking » : la pose 3D de la surface, image par image.
      Ces données sont enregistrées avec le projet.
    - L'effet dessine la grille 3D de la surface dans la fenêtre de composition quand il est
      sélectionné, d'après ces données.
    - « Créer : Null / Solide / Texte » : crée un calque 3D posé sur la surface (lié par
      expressions aux données : il suit un nouveau tracking appliqué), et la caméra si besoin.

    Unités des données : pixels de l'image du calque (avant mise à l'échelle dans la compo).
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
#define MINOR_VERSION 1
#define BUG_VERSION 0
#define STAGE_VERSION PF_Stage_DEVELOP
#define BUILD_VERSION 1

#define ST_MAX_PTS 32

enum {
    ST_INPUT = 0,
    ST_OPEN,
    ST_NEW_NULL,
    ST_NEW_SOLID,
    ST_NEW_TEXT,
    ST_SHOW,
    ST_DATA_START,
    ST_POS_X, ST_POS_Y, ST_POS_Z,
    ST_ORI_X, ST_ORI_Y, ST_ORI_Z,
    ST_WIDTH, ST_HEIGHT,
    ST_ZOOM, ST_DIST,
    ST_IMG_W, ST_IMG_H,
    ST_SHAPE,
    ST_NPTS,
    ST_PTS,                                // U1, V1, U2, V2, … (2 × ST_MAX_PTS)
    ST_DATA_END = ST_PTS + 2 * ST_MAX_PTS,
    ST_NUM_PARAMS
};

// identifiants disque : stables d'une version à l'autre (projets enregistrés)
enum {
    ID_OPEN = 1, ID_NEW_NULL, ID_NEW_SOLID, ID_NEW_TEXT, ID_SHOW, ID_DATA_START,
    ID_POS_X, ID_POS_Y, ID_POS_Z, ID_ORI_X, ID_ORI_Y, ID_ORI_Z, ID_WIDTH, ID_HEIGHT, ID_ZOOM, ID_DIST,
    ID_IMG_W, ID_IMG_H, ID_SHAPE, ID_NPTS, ID_DATA_END,
    ID_PTS = 100
};

enum { SHAPE_RECT = 1, SHAPE_DISC, SHAPE_FREE };

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

PF_Err AddSlider(PF_InData* in_data, const char* name, A_long id)
{
    PF_ParamDef def;
    AEFX_CLR_STRUCT(def);
    def.param_type = PF_Param_FLOAT_SLIDER;
    PF_STRNNCPY(def.PF_DEF_NAME, name, sizeof(def.PF_DEF_NAME));
    def.u.fs_d.valid_min = -1000000;
    def.u.fs_d.valid_max = 1000000;
    def.u.fs_d.slider_min = -10000;
    def.u.fs_d.slider_max = 10000;
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
    PF_ADD_BUTTON("Créer", "Null", 0, PF_ParamFlag_SUPERVISE, ID_NEW_NULL);
    AEFX_CLR_STRUCT(def);
    PF_ADD_BUTTON(" ", "Solide", 0, PF_ParamFlag_SUPERVISE, ID_NEW_SOLID);
    AEFX_CLR_STRUCT(def);
    PF_ADD_BUTTON("  ", "Texte", 0, PF_ParamFlag_SUPERVISE, ID_NEW_TEXT);
    AEFX_CLR_STRUCT(def);
    PF_ADD_CHECKBOXX("Afficher la grille", TRUE, 0, ID_SHOW);

    AEFX_CLR_STRUCT(def);
    def.flags = PF_ParamFlag_START_COLLAPSED;
    PF_ADD_TOPIC("Données du tracking", ID_DATA_START);
    const char* names[] = {"Position X", "Position Y", "Position Z", "Orientation X", "Orientation Y", "Orientation Z",
                           "Largeur", "Hauteur", "Zoom caméra", "Distance caméra", "Image L", "Image H"};
    const A_long ids[] = {ID_POS_X, ID_POS_Y, ID_POS_Z, ID_ORI_X, ID_ORI_Y, ID_ORI_Z,
                          ID_WIDTH, ID_HEIGHT, ID_ZOOM, ID_DIST, ID_IMG_W, ID_IMG_H};
    for (int i = 0; i < 12 && !err; i++) err = AddSlider(in_data, names[i], ids[i]);
    if (err) return err;
    AEFX_CLR_STRUCT(def);
    PF_ADD_POPUP("Forme", 3, SHAPE_RECT, "Rectangle|Disque|Libre", ID_SHAPE);
    err = AddSlider(in_data, "Points du contour", ID_NPTS);
    for (int i = 0; i < ST_MAX_PTS && !err; i++) {
        char name[32];
        std::snprintf(name, sizeof(name), "U%d", i + 1);
        err = AddSlider(in_data, name, ID_PTS + 2 * i);
        std::snprintf(name, sizeof(name), "V%d", i + 1);
        if (!err) err = AddSlider(in_data, name, ID_PTS + 2 * i + 1);
    }
    if (err) return err;
    AEFX_CLR_STRUCT(def);
    PF_END_TOPIC(ID_DATA_END);

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
    int shape;
    std::vector<double> poly;  // contour (u, v) 0..1, vide = rectangle
};

double Val(PF_ParamDef* p) { return p->u.fs_d.value; }

bool ReadPose(PF_ParamDef* params[], Pose& P)
{
    P.w = Val(params[ST_WIDTH]);
    P.h = Val(params[ST_HEIGHT]);
    P.dist = Val(params[ST_DIST]);
    P.zoom = Val(params[ST_ZOOM]);
    if (P.w <= 0 || P.h <= 0 || P.dist <= 0 || P.zoom <= 0) return false;  // rien d'appliqué
    P.px = Val(params[ST_POS_X]);
    P.py = Val(params[ST_POS_Y]);
    P.pz = Val(params[ST_POS_Z]);
    P.cx = Val(params[ST_IMG_W]) / 2;
    P.cy = Val(params[ST_IMG_H]) / 2;
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
    P.shape = params[ST_SHAPE]->u.pd.value;
    int n = static_cast<int>(Val(params[ST_NPTS]) + 0.5);
    if (P.shape == SHAPE_DISC) {
        for (int i = 0; i < 48; i++) {
            double t = 2 * M_PI * i / 48;
            P.poly.push_back(0.5 + 0.5 * cos(t));
            P.poly.push_back(0.5 + 0.5 * sin(t));
        }
    } else if (n >= 3) {
        for (int i = 0; i < std::min(n, ST_MAX_PTS); i++) {
            P.poly.push_back(Val(params[ST_PTS + 2 * i]));
            P.poly.push_back(Val(params[ST_PTS + 2 * i + 1]));
        }
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
    if (!ReadPose(params, P)) return PF_Err_NONE;
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
    if (v("Largeur") <= 0 || v("Image L") <= 0) {
        alert(TITLE + "\n\nAucun tracking appliqué : ouvrez le tracker, trackez, puis « Appliquer le tracking ».");
        return;
    }
    var k = comp.width / v("Image L");
    var base = "ST " + L.name;
    // référence aux données de l'effet (AE met à jour les noms dans les expressions s'ils changent)
    var ref = "var e = thisComp.layer(" + q(L.name) + ").effect(" + q(fx.name) + ");\n" +
              "var k = thisComp.width / e(\"Image L\");\n";
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
        var shape = fx.property("Forme").value, n = Math.round(v("Points du contour"));
        var verts = [], it = [], ot = [];
        if (shape === 2) {  // disque : masque circulaire
            var b = 0.5523;
            verts = [[w / 2, 0], [w, h / 2], [w / 2, h], [0, h / 2]];
            it = [[-b * w / 2, 0], [0, -b * h / 2], [b * w / 2, 0], [0, b * h / 2]];
            ot = [[b * w / 2, 0], [0, b * h / 2], [-b * w / 2, 0], [0, -b * h / 2]];
        } else if (n >= 3) {  // contour arrondi ou forme libre
            for (var p = 1; p <= n; p++) verts.push([v("U" + p) * w, v("V" + p) * h]);
        }
        if (verts.length) {
            var m = lay.property("ADBE Mask Parade").addProperty("ADBE Mask Atom"), s = new Shape();
            s.vertices = verts;
            if (it.length) { s.inTangents = it; s.outTangents = ot; }
            s.closed = true;
            m.property("ADBE Mask Shape").setValue(s);
        }
    } else {
        lay = comp.layers.addText("Texte");
        lay.name = base + " Texte";
        var tp = lay.property("ADBE Text Properties").property("ADBE Text Document"), td = tp.value;
        td.fontSize = Math.max(6, Math.round(0.22 * Math.min(w, h)));
        td.fillColor = [1, 1, 1];
        td.justification = ParagraphJustification.CENTER_JUSTIFY;
        tp.setValue(td);
        var r = lay.sourceRectAtTime(comp.time, false);
        lay.property("ADBE Transform Group").property("ADBE Anchor Point").setValue([r.left + r.width / 2, r.top + r.height / 2, 0]);
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
