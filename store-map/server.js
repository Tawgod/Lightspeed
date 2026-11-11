const http = require("http");
const fs = require("fs");
const path = require("path");
const { normalizePublicBasePath, stripPublicBasePath } = require("./publicBasePath");
const port = Number(process.env.PORT || 3000);
const root = __dirname;
const publicBasePath = normalizePublicBasePath(process.env.HC_PUBLIC_BASE_PATH || "");
const types = {".html":"text/html; charset=utf-8",".json":"application/json; charset=utf-8",".js":"text/javascript; charset=utf-8",".css":"text/css; charset=utf-8"};
http.createServer((req,res)=>{
  req.url = stripPublicBasePath(req.url, publicBasePath);
  if(req.url === "/health"){res.writeHead(200,{"content-type":"application/json"});return res.end(JSON.stringify({ok:true,service:"hobby-corner-store-map"}));}
  const raw=(req.url||"/").split("?")[0];
  const rel=raw==="/"?"index.html":raw.replace(/^\/+/, "");
  const file=path.join(root, rel);
  if(!file.startsWith(root)){res.writeHead(403);return res.end("Forbidden");}
  fs.readFile(file,(err,data)=>{
    if(err){res.writeHead(404,{"content-type":"text/plain; charset=utf-8"});return res.end("Not found");}
    res.writeHead(200,{"content-type":types[path.extname(file)]||"application/octet-stream","cache-control":"no-store"});
    res.end(data);
  });
}).listen(port,"0.0.0.0",()=>console.log("Store Map listening on",port));