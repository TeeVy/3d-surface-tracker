/*  3D Surface Tracker — effet.

    Appliqué en bas de la pile d'effets d'un calque, il ne modifie pas l'image. Il marque
    le calque à tracker : le panneau suit l'image du calque telle qu'elle arrive à cet
    effet (stabilisation et autres effets placés au-dessus compris), via le pont STBridge.
    Son bouton « Ouvrir le tracker » ouvre le panneau sur ce calque.
*/

#include "AEConfig.h"
#include "entry.h"
#include "AE_Effect.h"
#include "AE_EffectCB.h"
#include "AE_EffectCBSuites.h"
#include "AE_Macros.h"
#include "AE_GeneralPlug.h"
#include "AEGP_SuiteHandler.h"
#include "Param_Utils.h"

#include <cstdio>
#include <string>

#define MAJOR_VERSION 1
#define MINOR_VERSION 0
#define BUG_VERSION 0
#define STAGE_VERSION PF_Stage_DEVELOP
#define BUILD_VERSION 1

enum { ST_INPUT = 0, ST_OPEN, ST_NUM_PARAMS };
enum { OPEN_DISK_ID = 1 };

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
    out_data->out_flags = PF_OutFlag_DEEP_COLOR_AWARE;
    out_data->out_flags2 = PF_OutFlag2_SUPPORTS_THREADED_RENDERING;
    AEGP_SuiteHandler suites(in_data->pica_basicP);
    // identifiant AEGP : nécessaire pour exécuter un script depuis l'effet
    suites.UtilitySuite3()->AEGP_RegisterWithAEGP(nullptr, "3D Surface Tracker", &S_aegp_id);
    return PF_Err_NONE;
}

PF_Err ParamsSetup(PF_InData* in_data, PF_OutData* out_data)
{
    PF_ParamDef def;
    PF_ADD_BUTTON("Tracker", "Ouvrir le tracker", 0, PF_ParamFlag_SUPERVISE, OPEN_DISK_ID);
    out_data->num_params = ST_NUM_PARAMS;
    return PF_Err_NONE;
}

PF_Err Render(PF_InData* in_data, PF_LayerDef* output, PF_ParamDef* params[])
{
    // l'effet ne touche pas à l'image
    return PF_COPY(&params[ST_INPUT]->u.ld, output, nullptr, nullptr);
}

std::string JsString(const std::string& s)
{
    std::string out = "\"";
    for (char c : s) {
        if (c == '\\' || c == '"') out += '\\';
        out += c;
    }
    return out + "\"";
}

// Bouton : dépose la demande pour le panneau (même format que le script « Tracker le calque »)
// et ouvre le panneau s'il ne l'est pas déjà.
PF_Err OpenTracker(PF_InData* in_data)
{
    AEGP_SuiteHandler suites(in_data->pica_basicP);
    AEGP_LayerH layerH = nullptr;
    AEGP_CompH compH = nullptr;
    AEGP_ItemH itemH = nullptr;
    A_long comp_id = 0;
    A_long layer_index = 0;
    A_Err err = A_Err_NONE;
    ERR(suites.PFInterfaceSuite1()->AEGP_GetEffectLayer(in_data->effect_ref, &layerH));
    ERR(suites.LayerSuite9()->AEGP_GetLayerParentComp(layerH, &compH));
    ERR(suites.CompSuite11()->AEGP_GetItemFromComp(compH, &itemH));
    ERR(suites.ItemSuite9()->AEGP_GetItemID(itemH, &comp_id));
    ERR(suites.LayerSuite9()->AEGP_GetLayerIndex(layerH, &layer_index));
    if (err) return PF_Err_NONE;

    char head[160];
    std::snprintf(head, sizeof(head), "var ST_COMP = %ld, ST_LAYER = %ld;\n", static_cast<long>(comp_id),
                  static_cast<long>(layer_index + 1));  // AEGP compte depuis 0, ExtendScript depuis 1
    std::string script = std::string(head) + R"JSX(
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
        else alert(TITLE + "\n\nOuvrez le panneau : Fenêtre > Extensions > " + TITLE + ".");
    }
})();
)JSX";
    AEGP_MemHandle resultH = nullptr, errorH = nullptr;
    suites.UtilitySuite6()->AEGP_ExecuteScript(S_aegp_id, script.c_str(), FALSE, &resultH, &errorH);
    if (resultH) suites.MemorySuite1()->AEGP_FreeMemHandle(resultH);
    if (errorH) suites.MemorySuite1()->AEGP_FreeMemHandle(errorH);
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
            case PF_Cmd_USER_CHANGED_PARAM: {
                const PF_UserChangedParamExtra* ch = reinterpret_cast<const PF_UserChangedParamExtra*>(extra);
                if (ch && ch->param_index == ST_OPEN) err = OpenTracker(in_data);
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
