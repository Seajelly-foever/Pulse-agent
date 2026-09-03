import { config } from "./config.mjs";
import { openDatabase } from "./db.mjs";
const cfg=config(),[group,action,code]=process.argv.slice(2).filter((value)=>value!=="--");
if(group!=="pairing"||action!=="approve"||!code){console.error("用法：node local-runtime/src/cli.mjs pairing approve <六位配对码>");process.exitCode=1;}else{const identity=openDatabase(cfg.databasePath).approvePairing(code);if(!identity){console.error("配对码不存在或已失效");process.exitCode=1;}else console.log(`已授权：${identity.display_name||identity.provider_user_id}`);}
