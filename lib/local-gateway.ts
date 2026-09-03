// The Linux production build runs this module in a regular Node.js process.
// Importing `cloudflare:workers` here makes Node's ESM loader reject the whole
// route before it can proxy to the local Pulse Gateway. Cloud deployments do
// not use LOCAL_GATEWAY_URL, so process.env is the only runtime source needed
// by this bridge.
function runtime(){return typeof process!=="undefined"?process.env:{}}
export function localGatewayEnabled(){return Boolean(runtime().LOCAL_GATEWAY_URL)}
export async function localGateway(request:Request,path:string){
  const e=runtime();if(!e.LOCAL_GATEWAY_URL)return null;
  const target=`${e.LOCAL_GATEWAY_URL.replace(/\/$/,"")}${path}`;
  const body=request.method==="GET"||request.method==="HEAD"?undefined:await request.text();
  const response=await fetch(target,{method:request.method,headers:{"content-type":"application/json",authorization:`Bearer ${e.LOCAL_GATEWAY_SECRET||"pulse-local-dev"}`},body});
  return new Response(response.body,{status:response.status,headers:{"content-type":response.headers.get("content-type")||"application/json"}});
}
