#include "AEConfig.h"
#include "AE_General.r"

resource 'PiPL' (16000) {
	{
		Kind { AEGP },
		Name { "3D Surface Tracker Bridge" },
		Category { "General Plugin" },
		Version { 65536 },
		CodeMacIntel64 { "EntryPointFunc" },
		CodeMacARM64 { "EntryPointFunc" },
	}
};
