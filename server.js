const http    = require("http");
const fs      = require("fs");
const path    = require("path");
const url     = require("url");
const crypto  = require("crypto");

const PORT = 3000;
const HOST = "0.0.0.0";
const D    = path.join(__dirname, "data");

// ── bootstrap ─────────────────────────────────────────────────────────────────
[D].forEach(d => !fs.existsSync(d) && fs.mkdirSync(d, {recursive:true}));
const FILES = {
  patrimonios:   path.join(D, "patrimonios.json"),
  usuarios:      path.join(D, "usuarios.json"),
  tokens:        path.join(D, "tokens.json"),
  funcionarios:  path.join(D, "funcionarios.json"),
  notas_fiscais: path.join(D, "notas_fiscais.json"),
};
Object.entries(FILES).forEach(([k, f]) => {
  if (!fs.existsSync(f)) fs.writeFileSync(f, k === "tokens" ? "{}" : "[]");
});

// Cria admin padrão
const _users = readJSON(FILES.usuarios);
if (!_users.find(u => u.login === "admin.ti")) {
  _users.unshift({
    id: 1, nome: "Administrador TI", login: "admin.ti",
    senha: sha256("ti.server3945"), perfil: "ADMIN",
    obras_permitidas: [], ativo: true,
    created_at: new Date().toISOString()
  });
  writeJSON(FILES.usuarios, _users);
}

// ── utils ─────────────────────────────────────────────────────────────────────
function sha256(s) { return crypto.createHash("sha256").update(s).digest("hex"); }
function readJSON(f)    { try { return JSON.parse(fs.readFileSync(f,"utf8")); } catch { return []; } }
function writeJSON(f,d) { fs.writeFileSync(f, JSON.stringify(d,null,2)); }
function nextId(arr)    { return arr.length > 0 ? Math.max(...arr.map(x=>x.id||0)) + 1 : 1; }

// ── tokens ────────────────────────────────────────────────────────────────────
function createToken(userId) {
  const token = crypto.randomBytes(32).toString("hex");
  const t = readJSON(FILES.tokens);
  t[token] = { userId, created: Date.now() };
  writeJSON(FILES.tokens, t);
  return token;
}
function validateToken(token) {
  if (!token) return null;
  const t = readJSON(FILES.tokens);
  const e = t[token];
  if (!e || Date.now() - e.created > 8*3600*1000) {
    if (e) { delete t[token]; writeJSON(FILES.tokens, t); }
    return null;
  }
  return readJSON(FILES.usuarios).find(u => u.id === e.userId && u.ativo) || null;
}
function revokeToken(token) {
  const t = readJSON(FILES.tokens);
  delete t[token]; writeJSON(FILES.tokens, t);
}

// ── http helpers ──────────────────────────────────────────────────────────────
function cors(res) {
  res.setHeader("Access-Control-Allow-Origin","*");
  res.setHeader("Access-Control-Allow-Methods","GET,POST,PUT,DELETE,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers","Content-Type,Authorization");
}
function sendJSON(res, code, data) {
  cors(res);
  res.writeHead(code, {"Content-Type":"application/json"});
  res.end(JSON.stringify(data));
}
function serveFile(res, fp, ct) {
  fs.readFile(fp, (err, c) => {
    if (err) { res.writeHead(404); res.end("Not found"); return; }
    res.writeHead(200, {"Content-Type": ct});
    res.end(c);
  });
}
function getToken(req) {
  return (req.headers["authorization"]||"").replace("Bearer ","").trim()||null;
}
function readBody(req) {
  return new Promise(r => {
    let b = "";
    req.on("data", c => b += c);
    req.on("end", () => { try { r(JSON.parse(b)); } catch { r({}); } });
  });
}

// ── XLSX parser (sem dependências externas) ───────────────────────────────────
// Suporta: sharedStrings (Excel padrão), inlineStr (openpyxl/LibreOffice), números
const zlib = require("zlib");

function parseXLSXBase64(base64) {
  const buf = Buffer.from(base64, "base64");
  return parseXLSX(buf);
}

function parseXLSX(buffer) {
  try {
    const zip = unzip(buffer);
    // shared strings (Excel padrão)
    const ssXML = zip["xl/sharedStrings.xml"] || zip["xl/sharedstrings.xml"] || "";
    const strings = parseSharedStrings(ssXML);
    // procura sheet1 em qualquer variação de path
    const sheetKey = Object.keys(zip).find(k => /xl\/worksheets\/sheet1\.xml$/i.test(k)) || "";
    const sheetXML = sheetKey ? zip[sheetKey] : "";
    if (!sheetXML) return [];
    return parseSheet(sheetXML, strings);
  } catch(e) {
    console.error("[XLSX] parse error:", e.message);
    return [];
  }
}

// Decodifica entidades XML e caracteres numéricos &#NNN;
function decodeXML(s) {
  return (s || "")
    .replace(/&#(\d+);/g,  (_, n) => String.fromCharCode(parseInt(n)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'");
}

function parseSharedStrings(xml) {
  const strings = [];
  const re = /<si>([\s\S]*?)<\/si>/g;
  let m;
  while ((m = re.exec(xml)) !== null) {
    // concatena todos os <t> dentro do <si> (para rich text)
    const tRe = /<t(?:\s[^>]*)?>([^<]*)<\/t>/g;
    let text = "", tm;
    while ((tm = tRe.exec(m[1])) !== null) text += tm[1];
    strings.push(decodeXML(text));
  }
  return strings;
}

function parseSheet(xml, strings) {
  const rows = [];
  // strip namespace prefixes so regex works regardless of xmlns
  xml = xml.replace(/<(\/?)[a-zA-Z]+:/g, "<$1");
  const rowRe = /<row\b[^>]*>([\s\S]*?)<\/row>/g;
  let rm;
  while ((rm = rowRe.exec(xml)) !== null) {
    const cols = [];
    const cellRe = /<c\b([^>]*)>([\s\S]*?)<\/c>/g;
    let cm;
    while ((cm = cellRe.exec(rm[1])) !== null) {
      const attrs = cm[1], inner = cm[2];
      const rAttr  = (attrs.match(/\br="([^"]+)"/) || [])[1] || "";
      const tAttr  = (attrs.match(/\bt="([^"]+)"/) || [])[1] || "";
      const colIdx = colLetterToIdx(rAttr.replace(/[0-9]/g, ""));

      let val = "";
      if (tAttr === "s") {
        // sharedString index
        const v = (inner.match(/<v>([^<]*)<\/v>/) || [])[1];
        if (v != null) val = strings[parseInt(v)] || "";
      } else if (tAttr === "inlineStr") {
        // inline string — pode ser <is><t>…</t></is> ou <t>
        const t = (inner.match(/<t[^>]*>([^<]*)<\/t>/) || [])[1] || "";
        val = decodeXML(t);
      } else if (tAttr === "str") {
        // fórmula que resulta em string
        const t = (inner.match(/<v>([^<]*)<\/v>/) || [])[1] || "";
        val = decodeXML(t);
      } else {
        // número ou data
        const v = (inner.match(/<v>([^<]*)<\/v>/) || [])[1];
        if (v != null) val = v;
      }

      // preenche colunas vazias entre a última e a atual
      while (cols.length < colIdx) cols.push("");
      if (colIdx >= 0) cols[colIdx] = val;
    }
    if (cols.some(c => c !== "")) rows.push(cols);
  }
  return rows;
}

function colLetterToIdx(letters) {
  if (!letters) return 0;
  let n = 0;
  for (let i = 0; i < letters.length; i++)
    n = n * 26 + (letters.toUpperCase().charCodeAt(i) - 64);
  return n - 1;
}

// Minimal ZIP reader — trata corretamente o campo extra local
function unzip(buf) {
  const files = {};
  let i = 0;
  const u32 = o => (buf[o] | (buf[o+1]<<8) | (buf[o+2]<<16) | (buf[o+3]<<24)) >>> 0;
  const u16 = o => buf[o] | (buf[o+1]<<8);
  while (i + 30 < buf.length) {
    if (u32(i) !== 0x04034b50) { i++; continue; }
    const method   = u16(i + 8);
    const compSz   = u32(i + 18);
    const fnLen    = u16(i + 26);
    const exLen    = u16(i + 28);
    const fname    = buf.slice(i+30, i+30+fnLen).toString("utf8");
    const dataOff  = i + 30 + fnLen + exLen;
    if (dataOff + compSz > buf.length) { i++; continue; }
    const compressed = buf.slice(dataOff, dataOff + compSz);
    try {
      if      (method === 0) files[fname] = compressed.toString("utf8");
      else if (method === 8) files[fname] = zlib.inflateRawSync(compressed).toString("utf8");
    } catch { /* skip corrupt entry */ }
    i = dataOff + compSz;
  }
  return files;
}

// Mapeia linhas do Excel para objetos patrimônio
function rowsToPatrimonios(rows) {
  if (rows.length < 2) return [];
  const header = rows[0].map(h => (h||"").toLowerCase().trim());
  const find = (...keys) => {
    for (const k of keys) {
      const i = header.findIndex(h => h.includes(k));
      if (i >= 0) return i;
    }
    return -1;
  };

  const iNum   = find("número patrimônio","numero patrimonio","patrimônio","patrimonio","nº patrimônio","nº patrimonio","num patrimonio","num patrimônio","pat");
  const iMarca = find("marca");
  const iModel = find("modelo");
  const iSerie = find("série","serie","nº série","nº serie","número série","numero serie");
  const iProc  = find("processador","proc","cpu");
  const iRam   = find("ram","memória","memoria");
  const iHd    = find("armazenamento","hd","ssd","disco","storage");
  const iAno   = find("ano fabricação","ano fabricacao","ano fab","ano");
  const iData  = find("data aquisição","data aquisicao","data compra","aquisição","aquisicao","data");
  const iValor = find("valor","preço","preco","custo");
  const iStatus= find("status","situação","situacao");
  const iObra  = find("obra","unidade","local");
  const iResp  = find("responsável","responsavel");
  const iCodF  = find("código funcionário","codigo funcionario","cód func","cod func","código func","funcionario","funcionário");
  const iSetor = find("setor","departamento","dept");
  const iNF    = find("nota fiscal","nf","nota","nf número","nf numero");
  const iObs   = find("obs","observação","observacao","observações","observacoes","nota");

  const result = [];
  for (let r = 1; r < rows.length; r++) {
    const row = rows[r];
    if (!row || row.every(c => !c)) continue;
    const num = String(row[iNum] || "").trim();
    if (!num) continue;

    const statusRaw = iStatus >= 0 ? String(row[iStatus]||"").trim().toUpperCase() : "";
    // normaliza status
    let status = "ESTOQUE";
    if (statusRaw.includes("USO"))       status = "EM USO";
    else if (statusRaw.includes("ESTO")) status = "ESTOQUE";
    else if (statusRaw.includes("MANU")) status = "MANUTENÇÃO";
    else if (statusRaw.includes("DESC")) status = "DESCARTE";
    else if (statusRaw.includes("DOA") || statusRaw.includes("DOÇ")) status = "DOAÇÃO";
    else if (statusRaw.includes("RES"))  status = "RESERVA";
    else if (statusRaw)                  status = statusRaw;

    result.push({
      numero_patrimonio:  num,
      marca:              iMarca >= 0  ? String(row[iMarca]  ||"").trim() : "",
      modelo:             iModel >= 0  ? String(row[iModel]  ||"").trim() : "",
      numero_serie:       iSerie >= 0  ? String(row[iSerie]  ||"").trim() : "",
      processador:        iProc  >= 0  ? String(row[iProc]   ||"").trim() : "",
      memoria_ram:        iRam   >= 0  ? String(row[iRam]    ||"").trim() : "",
      armazenamento:      iHd    >= 0  ? String(row[iHd]     ||"").trim() : "",
      ano_fabricacao:     iAno   >= 0  ? String(row[iAno]    ||"").trim() : "",
      data_aquisicao:     iData  >= 0  ? String(row[iData]   ||"").trim() : "",
      valor:              iValor >= 0  ? String(row[iValor]  ||"").trim() : "",
      status,
      nome_obra:          iObra  >= 0  ? String(row[iObra]   ||"").trim() : "",
      responsavel:        iResp  >= 0  ? String(row[iResp]   ||"").trim() : "",
      codigo_funcionario: iCodF  >= 0  ? String(row[iCodF]   ||"").trim() : "",
      setor:              iSetor >= 0  ? String(row[iSetor]  ||"").trim() : "",
      numero_nota_fiscal: iNF    >= 0  ? String(row[iNF]     ||"").trim() : "",
      observacoes:        iObs   >= 0  ? String(row[iObs]    ||"").trim() : "",
    });
  }
  return result;
}

// Mapeia linhas do Excel para objetos funcionário
function rowsToFuncionarios(rows) {
  if (rows.length < 2) return [];
  // Primeira linha é cabeçalho — tenta mapear por nome
  const header = rows[0].map(h => (h||"").toLowerCase().trim());
  const find = (...keys) => {
    for (const k of keys) {
      const i = header.findIndex(h => h.includes(k));
      if (i>=0) return i;
    }
    return -1;
  };
  const iCod    = find("código","codigo","cod","id");
  const iNome   = find("nome");
  const iCargo  = find("cargo","função","funcao","função");
  const iObra   = find("obra","unidade","setor","local");
  const iStatus = find("status","situação","situacao","ativo");

  const result = [];
  for (let r = 1; r < rows.length; r++) {
    const row = rows[r];
    if (!row || row.every(c=>!c)) continue;
    const codigo = String(row[iCod]||"").trim();
    const nome   = String(row[iNome]||"").trim();
    if (!codigo && !nome) continue;
    result.push({
      codigo:  codigo || String(r),
      nome:    nome   || "—",
      cargo:   iCargo>=0  ? String(row[iCargo]||"").trim()  : "",
      obra:    iObra>=0   ? String(row[iObra]||"").trim()   : "",
      status:  iStatus>=0 ? String(row[iStatus]||"ATIVO").trim().toUpperCase() : "ATIVO",
    });
  }
  return result;
}

// ── SERVIDOR ──────────────────────────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  const p = url.parse(req.url, true).pathname;
  const m = req.method;

  if (m === "OPTIONS") { cors(res); res.writeHead(200); res.end(); return; }

  // statics
  if (!p.startsWith("/api")) {
    const fp = (p==="/"||p==="/index.html")
      ? path.join(__dirname,"public","index.html")
      : path.join(__dirname,"public",p);
    serveFile(res, fp, {".js":"text/javascript",".css":"text/css"}[path.extname(fp)]||"text/html");
    return;
  }

  // ── login/logout ────────────────────────────────────────────────────────────
  if (p==="/api/login" && m==="POST") {
    const {login,senha} = await readBody(req);
    const u = readJSON(FILES.usuarios).find(u=>u.login===login&&u.senha===sha256(senha)&&u.ativo);
    if (!u) { sendJSON(res,401,{error:"Login ou senha incorretos."}); return; }
    const {senha:_,...safe}=u;
    sendJSON(res,200,{token:createToken(u.id),user:safe});
    return;
  }
  if (p==="/api/logout" && m==="POST") { revokeToken(getToken(req)); sendJSON(res,200,{ok:true}); return; }

  // auth
  const cu = validateToken(getToken(req));
  if (!cu) { sendJSON(res,401,{error:"Não autorizado."}); return; }
  const isAdmin  = cu.perfil==="ADMIN";
  const isEditor = isAdmin || cu.perfil==="EDITOR";

  // ── /api/me ─────────────────────────────────────────────────────────────────
  if (p==="/api/me"&&m==="GET") { const{senha:_,...s}=cu; sendJSON(res,200,s); return; }

  // ── FUNCIONÁRIOS ─────────────────────────────────────────────────────────────
  if (p==="/api/funcionarios") {
    if (m==="GET") {
      let list = readJSON(FILES.funcionarios);
      if (!isAdmin && cu.obras_permitidas?.length > 0)
        list = list.filter(f => cu.obras_permitidas.includes(f.obra));
      sendJSON(res,200,list);
    } else if (m==="POST") {
      if (!isEditor) { sendJSON(res,403,{error:"Sem permissão."}); return; }
      const body = await readBody(req);
      const list = readJSON(FILES.funcionarios);
      const ex   = list.findIndex(f=>f.codigo===body.codigo);
      if (ex>=0) { list[ex]={...list[ex],...body,updated_at:new Date().toISOString()}; }
      else        { list.push({...body,id:nextId(list),created_at:new Date().toISOString()}); }
      writeJSON(FILES.funcionarios,list);
      sendJSON(res,201,list.find(f=>f.codigo===body.codigo));
    }
    return;
  }

  // ── IMPORTAR XLSX DE FUNCIONÁRIOS ────────────────────────────────────────────
  if (p==="/api/funcionarios/importar" && m==="POST") {
    if (!isEditor) { sendJSON(res,403,{error:"Sem permissão."}); return; }
    const body = await readBody(req);
    const { base64, inativar_ausentes } = body;
    if (!base64) { sendJSON(res,400,{error:"Arquivo não enviado."}); return; }

    const novosRows = rowsToFuncionarios(parseXLSXBase64(base64));
    if (!novosRows.length) { sendJSON(res,400,{error:"Nenhum dado válido encontrado na planilha."}); return; }

    const existing = readJSON(FILES.funcionarios);
    let criados=0, atualizados=0, inativados=0;
    const codigosNovos = new Set(novosRows.map(r=>r.codigo));

    // Atualiza / cria
    for (const novo of novosRows) {
      const idx = existing.findIndex(f=>f.codigo===novo.codigo);
      if (idx>=0) { existing[idx]={...existing[idx],...novo,updated_at:new Date().toISOString()}; atualizados++; }
      else { existing.push({...novo,id:nextId(existing),created_at:new Date().toISOString()}); criados++; }
    }
    // Inativa ausentes
    if (inativar_ausentes) {
      for (const f of existing) {
        if (!codigosNovos.has(f.codigo) && f.status==="ATIVO") {
          f.status="INATIVO"; f.updated_at=new Date().toISOString(); inativados++;
        }
      }
    }
    writeJSON(FILES.funcionarios, existing);
    sendJSON(res,200,{ok:true,criados,atualizados,inativados,total:novosRows.length});
    return;
  }

  // ── IMPORTAR XLSX DE PATRIMÔNIOS ─────────────────────────────────────────────
  if (p==="/api/patrimonios/importar" && m==="POST") {
    if (!isEditor) { sendJSON(res,403,{error:"Sem permissão."}); return; }
    const body = await readBody(req);
    const { base64, modo_duplicado = "pular" } = body; // modo: pular | atualizar
    if (!base64) { sendJSON(res,400,{error:"Arquivo não enviado."}); return; }

    const novosRows = rowsToPatrimonios(parseXLSXBase64(base64));
    if (!novosRows.length) { sendJSON(res,400,{error:"Nenhum dado válido encontrado. Verifique se a planilha tem cabeçalho com 'Número Patrimônio' ou 'Patrimônio'."}); return; }

    const existing  = readJSON(FILES.patrimonios);
    const funcs     = readJSON(FILES.funcionarios);
    let criados=0, atualizados=0, pulados=0, erros=[];

    for (const novo of novosRows) {
      // Enriquece com dados do funcionário se tiver código
      if (novo.codigo_funcionario) {
        const func = funcs.find(f => f.codigo === novo.codigo_funcionario);
        if (func) {
          if (!novo.responsavel)  novo.responsavel = func.nome;
          if (!novo.nome_obra)    novo.nome_obra   = func.obra;
          if (!novo.setor)        novo.setor       = func.cargo;
        } else {
          erros.push(`Cód. funcionário "${novo.codigo_funcionario}" não encontrado (patrimônio ${novo.numero_patrimonio})`);
        }
      }

      // Valida campo obrigatório
      if (!novo.numero_patrimonio) { erros.push("Linha sem número de patrimônio ignorada."); continue; }

      const idx = existing.findIndex(e => e.numero_patrimonio === novo.numero_patrimonio);
      if (idx >= 0) {
        if (modo_duplicado === "atualizar") {
          existing[idx] = { ...existing[idx], ...novo, id: existing[idx].id, updated_at: new Date().toISOString() };
          atualizados++;
        } else {
          pulados++;
        }
      } else {
        existing.push({ ...novo, id: nextId(existing), created_by: cu.id, created_at: new Date().toISOString() });
        criados++;
      }
    }

    writeJSON(FILES.patrimonios, existing);
    sendJSON(res,200,{ ok:true, criados, atualizados, pulados, erros, total: novosRows.length });
    return;
  }

  // buscar funcionário por código
  if (p.match(/^\/api\/funcionarios\/busca$/) && m==="GET") {
    const qs  = url.parse(req.url,true).query;
    const cod = (qs.codigo||"").trim();
    const func = readJSON(FILES.funcionarios).find(f=>f.codigo===cod);
    if (!func) { sendJSON(res,404,{error:"Funcionário não encontrado."}); return; }
    sendJSON(res,200,func);
    return;
  }

  const mFuncId = p.match(/^\/api\/funcionarios\/(\d+)$/);
  if (mFuncId) {
    const id = parseInt(mFuncId[1]);
    const list = readJSON(FILES.funcionarios);
    const idx  = list.findIndex(f=>f.id===id);
    if (idx<0) { sendJSON(res,404,{error:"Não encontrado."}); return; }
    if (m==="PUT") {
      if (!isEditor) { sendJSON(res,403,{error:"Sem permissão."}); return; }
      const body = await readBody(req);
      list[idx]={...list[idx],...body,id,updated_at:new Date().toISOString()};
      writeJSON(FILES.funcionarios,list); sendJSON(res,200,list[idx]);
    } else if (m==="DELETE") {
      if (!isAdmin) { sendJSON(res,403,{error:"Apenas admin."}); return; }
      list.splice(idx,1); writeJSON(FILES.funcionarios,list); sendJSON(res,200,{ok:true});
    }
    return;
  }

  // ── NOTAS FISCAIS ─────────────────────────────────────────────────────────────
  if (p==="/api/notas_fiscais") {
    if (m==="GET") { sendJSON(res,200,readJSON(FILES.notas_fiscais)); return; }
    if (m==="POST") {
      if (!isEditor) { sendJSON(res,403,{error:"Sem permissão."}); return; }
      const body = await readBody(req);
      const list = readJSON(FILES.notas_fiscais);
      if (list.find(n=>n.numero===body.numero)) { sendJSON(res,400,{error:"NF já cadastrada."}); return; }
      const item = {...body,id:nextId(list),created_at:new Date().toISOString()};
      list.push(item); writeJSON(FILES.notas_fiscais,list); sendJSON(res,201,item);
      return;
    }
  }

  const mNfId = p.match(/^\/api\/notas_fiscais\/(\d+)$/);
  if (mNfId) {
    const id   = parseInt(mNfId[1]);
    const list = readJSON(FILES.notas_fiscais);
    const idx  = list.findIndex(n=>n.id===id);
    if (idx<0) { sendJSON(res,404,{error:"NF não encontrada."}); return; }
    if (m==="PUT") {
      if (!isEditor) { sendJSON(res,403,{error:"Sem permissão."}); return; }
      const body = await readBody(req);
      list[idx]={...list[idx],...body,id}; writeJSON(FILES.notas_fiscais,list); sendJSON(res,200,list[idx]);
    } else if (m==="DELETE") {
      if (!isAdmin) { sendJSON(res,403,{error:"Apenas admin."}); return; }
      list.splice(idx,1); writeJSON(FILES.notas_fiscais,list); sendJSON(res,200,{ok:true});
    }
    return;
  }

  // ── PATRIMÔNIOS ───────────────────────────────────────────────────────────────
  if (p==="/api/patrimonios") {
    if (m==="GET") {
      let data = readJSON(FILES.patrimonios);
      if (!isAdmin && cu.obras_permitidas?.length>0)
        data = data.filter(d=>cu.obras_permitidas.includes(d.nome_obra));
      // Enriquece com dados do funcionário e NF
      const funcs = readJSON(FILES.funcionarios);
      const nfs   = readJSON(FILES.notas_fiscais);
      data = data.map(d => ({
        ...d,
        _funcionario: funcs.find(f=>f.codigo===d.codigo_funcionario) || null,
        _nota_fiscal: nfs.find(n=>n.numero===d.numero_nota_fiscal)   || null,
      }));
      sendJSON(res,200,data);
    } else if (m==="POST") {
      if (!isEditor) { sendJSON(res,403,{error:"Sem permissão."}); return; }
      const body = await readBody(req);
      // Valida funcionário se informado
      if (body.codigo_funcionario) {
        const func = readJSON(FILES.funcionarios).find(f=>f.codigo===body.codigo_funcionario);
        if (!func) { sendJSON(res,400,{error:`Funcionário código "${body.codigo_funcionario}" não encontrado.`}); return; }
        body.responsavel = func.nome;
        if (!body.setor && func.cargo) body.setor = func.cargo;
        if (!body.nome_obra && func.obra) body.nome_obra = func.obra;
      }
      const data = readJSON(FILES.patrimonios);
      const item = {...body,id:nextId(data),created_by:cu.id,created_at:new Date().toISOString()};
      data.push(item); writeJSON(FILES.patrimonios,data); sendJSON(res,201,item);
    }
    return;
  }

  const mPat = p.match(/^\/api\/patrimonios\/(\d+)$/);
  if (mPat) {
    const id   = parseInt(mPat[1]);
    const data = readJSON(FILES.patrimonios);
    const idx  = data.findIndex(d=>d.id===id);
    if (idx<0) { sendJSON(res,404,{error:"Não encontrado."}); return; }
    if (m==="PUT") {
      if (!isEditor) { sendJSON(res,403,{error:"Sem permissão."}); return; }
      const body = await readBody(req);
      // Valida funcionário se mudou
      if (body.codigo_funcionario) {
        const func = readJSON(FILES.funcionarios).find(f=>f.codigo===body.codigo_funcionario);
        if (!func) { sendJSON(res,400,{error:`Funcionário código "${body.codigo_funcionario}" não encontrado.`}); return; }
        body.responsavel = func.nome;
        if (!body.setor)     body.setor     = func.cargo||data[idx].setor;
        if (!body.nome_obra) body.nome_obra  = func.obra||data[idx].nome_obra;
      }
      data[idx]={...data[idx],...body,id,updated_at:new Date().toISOString()};
      writeJSON(FILES.patrimonios,data); sendJSON(res,200,data[idx]);
    } else if (m==="DELETE") {
      if (!isAdmin) { sendJSON(res,403,{error:"Apenas admin."}); return; }
      data.splice(idx,1); writeJSON(FILES.patrimonios,data); sendJSON(res,200,{ok:true});
    }
    return;
  }

  // ── OBRAS ─────────────────────────────────────────────────────────────────────
  if (p==="/api/obras"&&m==="GET") {
    const data  = readJSON(FILES.patrimonios);
    const funcs = readJSON(FILES.funcionarios);
    const obras = [...new Set([
      ...data.map(d=>d.nome_obra),
      ...funcs.map(f=>f.obra)
    ].filter(Boolean))].sort();
    sendJSON(res,200,obras); return;
  }

  // ── USUÁRIOS ──────────────────────────────────────────────────────────────────
  if (p==="/api/usuarios") {
    if (!isAdmin) { sendJSON(res,403,{error:"Acesso negado."}); return; }
    if (m==="GET") { sendJSON(res,200,readJSON(FILES.usuarios).map(u=>{const{senha:_,...s}=u;return s;})); return; }
    if (m==="POST") {
      const body  = await readBody(req);
      const users = readJSON(FILES.usuarios);
      if (users.find(u=>u.login===body.login)) { sendJSON(res,400,{error:"Login já existe."}); return; }
      const user = {...body,id:nextId(users),senha:sha256(body.senha),ativo:true,created_at:new Date().toISOString()};
      users.push(user); writeJSON(FILES.usuarios,users);
      const{senha:_,...safe}=user; sendJSON(res,201,safe);
      return;
    }
  }
  const mUsr = p.match(/^\/api\/usuarios\/(\d+)$/);
  if (mUsr) {
    if (!isAdmin) { sendJSON(res,403,{error:"Acesso negado."}); return; }
    const id = parseInt(mUsr[1]);
    const users = readJSON(FILES.usuarios);
    const idx   = users.findIndex(u=>u.id===id);
    if (idx<0) { sendJSON(res,404,{error:"Não encontrado."}); return; }
    if (m==="PUT") {
      const body = await readBody(req);
      if (body.senha) body.senha=sha256(body.senha); else delete body.senha;
      users[idx]={...users[idx],...body,id}; writeJSON(FILES.usuarios,users);
      const{senha:_,...safe}=users[idx]; sendJSON(res,200,safe);
    } else if (m==="DELETE") {
      if (id===1) { sendJSON(res,400,{error:"Não pode remover admin principal."}); return; }
      users.splice(idx,1); writeJSON(FILES.usuarios,users); sendJSON(res,200,{ok:true});
    }
    return;
  }

  sendJSON(res,404,{error:"Rota não encontrada."});
});

server.listen(PORT,HOST,()=>{
  const nets = require("os").networkInterfaces();
  const ips  = [];
  for (const n of Object.keys(nets))
    for (const i of nets[n])
      if (i.family==="IPv4"&&!i.internal) ips.push(i.address);

  console.log("\n╔══════════════════════════════════════════╗");
  console.log("║     PATRIMONIX v3 · SERVIDOR ATIVO        ║");
  console.log("╠══════════════════════════════════════════╣");
  console.log(`║  Local:  http://localhost:${PORT}             ║`);
  ips.forEach(ip => console.log(`║  Rede:   http://${ip}:${PORT}`.padEnd(44)+"║"));
  console.log("╠══════════════════════════════════════════╣");
  console.log("║  admin.ti / ti.server3945                 ║");
  console.log("╚══════════════════════════════════════════╝\n");
});
