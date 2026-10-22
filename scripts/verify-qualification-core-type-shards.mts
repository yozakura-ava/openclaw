import { verifyQualificationCoreTypeShardArtifacts } from "./lib/qualification-core-type-shards.mts";

const result = verifyQualificationCoreTypeShardArtifacts();
process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
