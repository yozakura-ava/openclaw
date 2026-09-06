#!/usr/bin/env node

// Production builds must start from an isolated output tree.  The tsdown
// wrapper also cleans before its individual invocation, but build-all may
// restore several independently cached outputs between invocations.
import { cleanTsdownOutputRoots } from "./tsdown-build.mts";

cleanTsdownOutputRoots({ env: process.env });
