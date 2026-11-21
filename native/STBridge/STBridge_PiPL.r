#include "AEConfig.h"
#ifndef AE_OS_WIN
#include "AE_General.r"
#endif

resource 'PiPL' (16000) {
	{
		Kind { AEGP },
		Name { "3D Surface Tracker Bridge" },
		Category { "General Plugin" },
		Version { 65536 },
#ifdef AE_OS_WIN
		CodeWin64X86 { "EntryPointFunc" },
#else
		CodeMacIntel64 { "EntryPointFunc" },
		CodeMacARM64 { "EntryPointFunc" },
#endif
	}
};
