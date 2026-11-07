#include "AEConfig.h"
#include "AE_EffectVers.h"
#include "AE_General.r"

resource 'PiPL' (16000) {
	{
		Kind { AEEffect },
		Name { "3D Surface Tracker" },
		Category { "3D Surface Tracker" },
		CodeMacIntel64 { "EffectMain" },
		CodeMacARM64 { "EffectMain" },
		AE_PiPL_Version { 2, 0 },
		AE_Effect_Spec_Version { PF_PLUG_IN_VERSION, PF_PLUG_IN_SUBVERS },
		AE_Effect_Version { 655361 },	/* 1.4 */
		AE_Effect_Info_Flags { 0 },
		AE_Effect_Global_OutFlags { 0x02008000 },	/* DEEP_COLOR_AWARE | CUSTOM_UI */
		AE_Effect_Global_OutFlags_2 { 0x08000000 },	/* SUPPORTS_THREADED_RENDERING */
		AE_Effect_Match_Name { "SurfTrack 3D Surface Tracker" },
		AE_Reserved_Info { 0 },
		AE_Effect_Support_URL { "https://github.com" }
	}
};
