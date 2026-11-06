// Trang nap cong khai
import { ESPLoader, Transport } from "https://cdn.jsdelivr.net/npm/esptool-js@0.7.0/bundle.js";
import {
  auth, db, BRAND, authReady, signInAnonymously, deviceInfo, country, esc, normCode,
  doc, getDoc, getDocs, updateDoc, setDoc, addDoc, collection, serverTimestamp, increment, arrayUnion, MAX_USES,
} from "./fb.js";
import { loadGuide, guideHtml, pinsHtml } from "./guides.js";
import { downloadPins, downloadGuide } from "./taive.js";
import { applyUI } from "./giaodien.js";
import { identify, espDetails, checkFit } from "./chip.js";
import { loadOptions, renderOptions, checkOptions, buildConfig, attachConfig } from "./tuychon.js";

const $ = (id) => document.getElementById(id);
let siteCfg = {};
let projects = [], cur = null, codeInfo = null, busy = false, uid = null;
let limitCfg = null, credit = false, cdTimer = 0;   // gioi han nap ban thuong; credit = da tru 1 luot nhung chua nap xong (Thu lai khong tru them)
const fwCache = {};                              // firmware da tai trong lan mo trang nay -> nap mach khac khong tai lai
let ownerUser = false, ownerMode = false;   // ownerMode: chu trang bam "bo qua ma" -> Pro khong can ma, khong tru luot (mac dinh van hoi ma nhu khach)
let unlocked = null; // ma da kich hoat trong lan mo trang nay -> "Thu lai" khong tinh them luot

const md5u8 = (u8) => SparkMD5.ArrayBuffer.hash(u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength));

// ---------- Khoi dong ----------
$("brand").textContent = BRAND.handle;
$("brand2").textContent = BRAND.handle;
if (!("serial" in navigator)) $("noSerial").classList.remove("hide");

(async () => {
  try {
    if (!(await authReady())) await signInAnonymously(auth);
    uid = auth.currentUser.uid;
    ownerUser = !auth.currentUser.isAnonymous;     // chu trang dang dang nhap (trang quan ly) tren trinh duyet nay
  } catch (e) { console.warn("auth", e); }
  logVisit();
  loadContact();
  loadLimit();
  loadDonate();
  await loadProjects();
})();

async function logVisit() {
  if (!uid) return;
  try {
    await addDoc(collection(db, "visits"), {
      ...deviceInfo(), uid, at: serverTimestamp(), page: "index",
      ref: (document.referrer || "").slice(0, 200), country: await country(),
      hash: location.hash.slice(1, 60),
    });
  } catch (e) { console.warn("visit", e); }
}

async function loadContact() {
  try {
    const c = (await getDoc(doc(db, "config", "site"))).data() || {};
    siteCfg = c;
    applyUI(c, cur?.board || cur?.chip || "ESP32");
    renderContact(c);
    renderPacks(c.packs);
    if (c.seller) $("polSeller").textContent = c.seller;
    if (c.refund) $("polRefund").textContent = c.refund;
    applyPageBg(c.pagebg);
  } catch (e) { console.warn("contact", e); renderContact({}); }
}
// ---------- Anh nen trang (tu doi moi ngay nhu trang chu Google, hoac anh rieng cua chu trang) ----------
async function applyPageBg(b) {
  const el = $("pageBg");
  if (!b || !b.mode || b.mode === "none") return;
  let url = "";
  if (b.mode === "daily") {
    const d = new Date(), seed = `tsl${d.getFullYear()}${d.getMonth() + 1}${d.getDate()}${b.seed || ""}`;
    const w = Math.min(1920, Math.round(screen.width * (window.devicePixelRatio || 1))), h = Math.round(w * 9 / 16);
    url = `https://picsum.photos/seed/${seed}/${w}/${Math.max(h, Math.round(screen.height * (window.devicePixelRatio || 1) * .6))}`;
  } else if (b.mode === "own") {
    try { url = (await getDoc(doc(db, "config", "pagebg"))).data()?.img || ""; } catch {}
  }
  if (!url) return;
  const img = new Image();
  img.onload = () => {
    el.style.backgroundImage = `url("${img.src}")`;
    el.style.setProperty("--bgdim", String((b.dark ?? 60) / 100));
    el.classList.toggle("blur", !!b.blur);
    el.classList.remove("hide");
    document.body.classList.add("has-bg");
  };
  img.src = url;
}

// ---------- QR ung ho (chu trang dang trong Cai dat) ----------
let donate = null;
async function loadDonate() {
  try { donate = (await getDoc(doc(db, "config", "donate"))).data() || null; } catch { donate = null; }
  const on = !!(donate && donate.on && donate.img);
  $("donSec").classList.toggle("hide", !on);
  if (!on) return;
  $("donImg").src = donate.img;
  $("donT").textContent = donate.title || "☕ Ủng hộ mình";
  $("donP").textContent = donate.text || "Nếu thấy dự án hữu ích, bạn có thể ủng hộ mình một ly cà phê để có thêm động lực làm dự án mới. Cảm ơn bạn!";
  $("donImg").onclick = () => $("donImg").classList.toggle("big");
}
// Sau khi nap thanh cong: chi 1 dong loi cam on + link xuong khung QR cuoi trang (khong hien them QR thu 2)
const donateMini = () => donate && donate.on && donate.img && donate.afterFlash !== false
  ? `<p class="small muted" style="margin-top:12px">${esc(donate.thanks || "Thấy hữu ích thì ủng hộ mình 1 ly cà phê nhé ☕")} <a href="#donSec" class="don-link">Xem mã QR</a></p>` : "";

// ---------- Gioi han nap ban thuong (chu trang chinh trong trang quan ly) ----------
async function loadLimit() {
  try { limitCfg = (await getDoc(doc(db, "config", "limit"))).data() || null; } catch { limitCfg = null; }
  if (limited(tier())) showQuota();
}
const limOn = () => !!(limitCfg && limitCfg.on && limitCfg.n > 0 && limitCfg.mins > 0);
const hrs = (m) => m % 60 ? m + " phút" : (m / 60) + " giờ";
async function quotaState() {
  if (!limOn() || !uid) return { ok: true, left: Infinity };
  let q = null;
  try { q = (await getDoc(doc(db, "quota", uid))).data() || null; } catch {}
  const win = limitCfg.mins * 60000, now = Date.now(), st = q?.start?.toMillis?.() || 0;
  if (!q || now >= st + win) return { ok: true, left: limitCfg.n, fresh: true };
  const left = limitCfg.n - (q.n || 0);
  return { ok: left > 0, left: Math.max(0, left), resetAt: st + win };
}
async function consumeQuota(qs) {
  if (!limOn()) return;
  const ref = doc(db, "quota", uid);
  if (qs.fresh) await setDoc(ref, { start: serverTimestamp(), n: 1, at: serverTimestamp() });
  else await updateDoc(ref, { n: increment(1), at: serverTimestamp() });
}
async function showQuota() {
  const box = $("quotaBox");
  clearInterval(cdTimer);
  if (!limited(tier()) || !limOn() || busy) { box.classList.add("hide"); return; }
  const qs = await quotaState();
  if (!limited(tier())) return;
  const L = limitCfg;
  if (qs.ok || credit) {
    box.className = "quota tiny";
    box.innerHTML = credit ? "" : `${tier() === "pro" ? "Pro miễn phí" : "Bản thường"}: còn <b>${qs.left}/${L.n}</b> lượt nạp trong ${hrs(L.mins)}.`;
    $("go").disabled = false;
    return;
  }
  const pro = proOn(cur) && !proFree(cur) && tier() === "free";
  box.className = "quota note warn";
  const tick = () => {
    const ms = qs.resetAt - Date.now();
    if (ms <= 0) { clearInterval(cdTimer); showQuota(); return; }
    const t = Math.ceil(ms / 1000), h = Math.floor(t / 3600), m = Math.floor(t % 3600 / 60), sec = t % 60;
    const clk = (h ? h + ":" + String(m).padStart(2, "0") : m) + ":" + String(sec).padStart(2, "0");
    box.innerHTML = `⏳ Bạn đã dùng hết <b>${L.n}/${L.n}</b> lượt nạp ${tier() === "pro" ? "miễn phí" : "bản thường"} trong ${hrs(L.mins)}.
      <div class="cd">${clk}</div><div>Hết giờ đếm ngược là nạp tiếp được.</div>
      <div class="upsell">${pro ? `💎 Cần nạp nhiều mạch hoặc dùng thêm tính năng? <b>Bản Pro</b> không giới hạn lượt theo giờ, có tiếng Việt, đồng hồ + thời tiết, ảnh nền… <a href="#" id="toPro">Xem bản Pro</a>` : "💬 Cần nạp nhiều mạch cùng lúc? Liên hệ mình ở cuối trang nhé."}</div>`;
    const tp = $("toPro"); if (tp) tp.onclick = (e) => { e.preventDefault(); setTier("pro"); $("code").focus(); };
  };
  tick(); cdTimer = setInterval(tick, 1000);
  $("go").disabled = true;
}

// Cac goi ma Pro (chu trang dat trong Cai dat): ten, so lan nap, gia, ghi chu, noi bat
// ---------- Bang gia ban Pro (popup khi khach chon Pro lan dau) ----------
const PACK_NOTES_DEFAULT = [
  "Mỗi mã nạp được số mạch theo gói. Nạp lại cho mạch đã nạp bằng mã đó (cập nhật, nạp lỗi…) không tính thêm.",
  "Bản quyền gắn với từng mạch, không chuyển sang mạch khác được.",
  "Mã dùng cho dự án đang xem, trừ khi được ghi là dùng cho tất cả dự án.",
  "Liên hệ để nhận mã sau khi thanh toán. Không nạp được do lỗi phía mình thì đổi mã hoặc hoàn tiền.",
];
const pmShown = new Set();
function openProModal() {
  const c = siteCfg || {}, ps = (c.packs || []).filter((x) => x && x.name && x.uses > 0);
  $("pmFeat").innerHTML = (cur?.pro?.features || []).map((x) => `<li>${esc(x)}</li>`).join("");
  $("pmPacks").innerHTML = ps.length ? ps.map((x, i) => `<div class="pack ${x.hot ? "hot" : ""}" data-i="${i}" role="button" tabindex="0"><span class="pick"></span>${x.hot ? '<span class="tag">Nhiều người chọn</span>' : ""}
    <div class="nm">${esc(x.name)}</div><div class="pr">${esc(x.price || "Liên hệ")}</div>
    <div class="us"><b>${x.uses}</b> mạch</div>${x.note ? `<div class="nt">${esc(x.note)}</div>` : ""}</div>`).join("")
    : '<div class="note" style="grid-column:1/-1">Liên hệ để biết giá và nhận mã.</div>';
  $("pmPick").classList.toggle("hide", !ps.some((x) => x.hasQr));
  $("pmPay").classList.add("hide");
  $("pmPacks").querySelectorAll(".pack").forEach((el) => {
    const pick = () => pickPack(ps[+el.dataset.i], el);
    el.onclick = pick; el.onkeydown = (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); pick(); } };
  });
  const notes = (c.packNotes || "").split("\n").map((x) => x.trim()).filter(Boolean);
  $("pmNotes").innerHTML = (notes.length ? notes : PACK_NOTES_DEFAULT).map((x) => `<li>${esc(x)}</li>`).join("");
  $("proModal").classList.remove("hide");
}
// Khach chon goi -> hien QR chuyen khoan cua goi (chu trang tao san, da co so tien) + noi dung chuyen khoan de doi chieu
let packQr = null;
async function pickPack(x, el) {
  $("pmPacks").querySelectorAll(".pack").forEach((e) => e.classList.toggle("sel", e === el));
  if (!packQr) { try { packQr = (await getDoc(doc(db, "config", "packqr"))).data() || {}; } catch { packQr = {}; } }
  const img = packQr[x.q];
  if (!img) { $("pmPay").classList.add("hide"); return; }
  const ref = ("TSL " + (cur?.id || "").replace(/[^a-z0-9]/gi, "").slice(0, 6) + " " + Math.random().toString(36).slice(2, 6)).toUpperCase();
  $("pmQr").src = img; $("pmPName").textContent = x.name; $("pmPPrice").textContent = x.price || "";
  $("pmRef").textContent = ref; $("pmPay").classList.remove("hide");
  $("pmCopy").onclick = () => { navigator.clipboard?.writeText(ref); $("pmCopy").textContent = "Đã chép"; setTimeout(() => $("pmCopy").textContent = "Chép", 1500); };
  $("pmPay").scrollIntoView({ behavior: "smooth", block: "nearest" });
}
const closeProModal = () => $("proModal").classList.add("hide");
$("pmX").onclick = closeProModal;
$("proModal").onclick = (e) => { if (e.target.id === "proModal") closeProModal(); };
document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeProModal(); });
$("pmHave").onclick = () => { closeProModal(); $("code").focus(); };
$("pmOpen").onclick = (e) => { e.preventDefault(); openProModal(); };

function renderPacks(list) {
  const ps = (list || []).filter((x) => x && x.name && x.uses > 0);
  const box = $("packs");
  box.classList.add("hide");                        // khong hien 3 the goi duoi o nhap ma nua: chi hien trong bang gia (popup)
  $("pmOpen").classList.toggle("hide", siteCfg.packsOn === false);
  if (!ps.length) return;
  box.innerHTML = ps.map((x) => `<div class="pack ${x.hot ? "hot" : ""}">${x.hot ? '<span class="tag">Nhiều người chọn</span>' : ""}
    <div class="nm">${esc(x.name)}</div><div class="pr">${esc(x.price || "Liên hệ")}</div>
    <div class="us"><b>${x.uses}</b> mạch</div>${x.note ? `<div class="nt">${esc(x.note)}</div>` : ""}</div>`).join("");
  $("usesNote").innerHTML = "📌 Mỗi mã nạp được số mạch theo gói. <b>Nạp lại cho mạch đã nạp</b> bằng mã đó thì không tính thêm.";
}

function renderContact(c) {
  const tt = (c.tiktok || BRAND.handle).replace(/^@/, "");
  const list = [];
  // Zalo: khong bao gio hien so dien thoai, chi hien chu ban tu dat (zaloName)
  if (c.zalo) list.push(["💬 Zalo", c.zaloName || "", /^https?:/.test(c.zalo) ? c.zalo : "https://zalo.me/" + c.zalo.replace(/\D/g, "")]);
  if (c.facebook) list.push(["📘 Facebook", c.facebookName || "", c.facebook]);
  list.push(["🎵 TikTok", "@" + tt, "https://www.tiktok.com/@" + tt]);
  if (c.other) list.push(["🔗 " + (c.otherName || "Liên hệ"), "", c.other]);
  $("tt").href = "https://www.tiktok.com/@" + tt;
  document.querySelectorAll("[data-contact]").forEach((box) => {
    const big = box.hasAttribute("data-big");
    box.innerHTML = list.map(([n, v, u]) =>
      `<a class="btn ${big ? "" : "sm"}" href="${esc(u)}" target="_blank" rel="noopener">${esc(n)}${v ? ` <span class="muted" style="font-weight:500">${esc(v)}</span>` : ""}</a>`).join("");
  });
}

async function loadProjects() {
  try {
    const s = await getDocs(collection(db, "projects"));
    projects = s.docs.map((d) => ({ id: d.id, ...d.data() })).filter((p) => p.visible !== false)
      .sort((a, b) => (a.order ?? 99) - (b.order ?? 99));
  } catch (e) {
    $("projects").innerHTML = `<div class="card note bad">Không tải được danh sách dự án. Thử tải lại trang.</div>`;
    return;
  }
  $("pcount").textContent = projects.length + " dự án";
  $("projects").innerHTML = projects.map((p) => `
    <div class="card proj" data-id="${esc(p.id)}">
      <div class="cov">${p.cover ? `<img src="${esc(p.cover)}" alt="">` : esc(p.emoji || "🔧")}</div>
      <div class="bd"><h3>${esc(p.name)}</h3><div class="muted small">${esc(p.desc || "")}</div>
        <div class="meta"><span class="pill">${esc(p.chip || "ESP32")}</span>
          ${freeOn(p) ? '<span class="pill ok">Miễn phí</span>' : ""}
          ${proOn(p) ? (proFree(p) ? '<span class="pill pro">Pro miễn phí</span>' : '<span class="pill pro">Có bản Pro</span>') : ""}</div></div>
    </div>`).join("") || '<div class="card muted">Chưa có dự án nào.</div>';
  document.querySelectorAll(".proj").forEach((el) => el.onclick = () => pick(el.dataset.id, true));
  const h = decodeURIComponent(location.hash.slice(1));
  if (h && projects.some((p) => p.id === h)) pick(h, true);
  else if (projects.length === 1) pick(projects[0].id, false);
}

// ---------- Chon du an / ban ----------
const freeOn = (p) => p.freeOn !== false && !!p.free?.parts?.length;   // chu trang bat/tat tung ban trong trang quan ly
const proOn = (p) => p.proOn !== false && !!p.pro?.parts?.length;
const proFree = (p) => p?.proFree === true;                             // chu trang tat ma: ai cung nap duoc ban Pro
const noCode = () => proFree(cur) || ownerMode;                       // ban Pro khong can nhap ma
const limited = (t) => !ownerMode && (t === "free" || (t === "pro" && proFree(cur)));   // ban bi gioi han luot nap theo gio (dung chung 1 bo dem)
let hasOpts = false, chipInfo = null, savedPort = null, goText = "";

function pick(id, scroll) {
  if (busy) return;
  cur = projects.find((p) => p.id === id);
  document.querySelectorAll(".proj").forEach((el) => el.classList.toggle("sel", el.dataset.id === id));
  history.replaceState(null, "", "#" + id);
  $("flashSec").classList.remove("hide");
  $("pName").textContent = cur.name;
  $("pChip").textContent = cur.chip || "ESP32";
  $("pDesc").textContent = cur.longDesc || cur.desc || "";
  // Du an co ban choi thu tren web (thu muc choi/<ma du an>/) -> hien nut "Choi thu"
  $("pPlay").classList.add("hide");
  { const pid0 = cur.id; fetch(`choi/${pid0}/index.html`, { method: "HEAD", cache: "no-cache" }).then((r) => {
      if (r.ok && cur && cur.id === pid0) { $("pPlay").href = `choi/${pid0}/`; $("pPlay").classList.remove("hide"); } }).catch(() => {}); }
  applyUI(siteCfg, cur.board || cur.chip || "ESP32");   // khung "Can chuan bi" co ten mach cua du an
  $("pNote").textContent = cur.note || "";
  $("pNote").classList.toggle("hide", !cur.note);
  // Danh sach tinh nang: hien 4 dong dau, con lai an sau nut "Xem them"
  const li = (a) => {
    a = a || [];
    const head = a.slice(0, 4).map((x) => `<li>${esc(x)}</li>`).join("");
    if (a.length <= 4) return head;
    return head + a.slice(4).map((x) => `<li class="more hide">${esc(x)}</li>`).join("") +
      `<li class="more-btn"><a href="#" data-more>＋ Xem thêm ${a.length - 4} tính năng</a></li>`;
  };
  $("fFree").innerHTML = li(cur.free?.features); $("vFree").textContent = cur.free?.ver ? "Phiên bản " + cur.free.ver : "";
  $("fPro").innerHTML = li(cur.pro?.features);
  document.querySelectorAll("#fFree [data-more], #fPro [data-more]").forEach((a) => a.onclick = (e) => {
    e.preventDefault(); e.stopPropagation();                // khong chon ban khi bam "Xem them"
    const ul = a.closest("ul"), open = ul.classList.toggle("open");
    ul.querySelectorAll("li.more").forEach((x) => x.classList.toggle("hide", !open));
    a.textContent = open ? "－ Thu gọn" : `＋ Xem thêm ${ul.querySelectorAll("li.more").length} tính năng`;
  }); $("vPro").textContent = cur.pro?.ver ? "Phiên bản " + cur.pro.ver : "";
  const hasF = freeOn(cur), hasP = proOn(cur);
  $("tFree").classList.toggle("hide", !hasF);
  $("tPro").classList.toggle("hide", !hasP);
  $("tiers").classList.toggle("one", hasF !== hasP);
  $("noTier").classList.toggle("hide", hasF || hasP);
  clearTier();
  $("done").classList.add("hide"); $("run").classList.add("hide"); $("go").classList.remove("hide");
  credit = false;
  codeInfo = null; $("code").value = ""; $("codeMsg").classList.add("hide"); $("proGet").classList.remove("hide"); renderPacks(siteCfg.packs);
  showFit();
  hasOpts = false;
  const pid = cur.id;
  loadOptions(cur).then((has) => {
    if (!cur || cur.id !== pid) return;
    hasOpts = has;
    if (tier() && !(tier() === "pro" && !codeInfo)) { $("optBox").classList.toggle("hide", !has); if (has) renderOptions($("optForm"), tier(), proOn(cur)); }
  });
  if (scroll) $("flashSec").scrollIntoView({ behavior: "smooth", block: "start" });
}

// Chua chon ban: an huong dan, so do chan, tuy chinh; khoa nut nap
function clearTier() {
  document.querySelectorAll("input[name=tier]").forEach((r) => r.checked = false);
  $("tFree").classList.remove("on"); $("tPro").classList.remove("on");
  $("proBox").classList.add("hide");
  $("infoSec").classList.add("hide");
  $("optBox").classList.add("hide");
  $("proWait").classList.add("hide"); $("ownerSkip").classList.add("hide"); $("proFreeNote").classList.add("hide");
  $("quotaBox").classList.add("hide"); clearInterval(cdTimer);
  $("reqCard").open = true;
  $("dlBox").classList.add("hide"); $("dlLock").classList.add("hide");
  shownTier = null;
  if (!goText) goText = $("go").dataset.label || $("go").innerHTML;
  $("go").disabled = true;
  $("go").textContent = "Chọn phiên bản ở trên để nạp";
}
function tier() { return document.querySelector("input[name=tier]:checked")?.value || null; }
function setTier(t) {
  document.querySelector(`input[name=tier][value=${t}]`).checked = true;
  $("tFree").classList.toggle("on", t === "free");
  $("tPro").classList.toggle("on", t === "pro");
  $("ownerSkip").classList.toggle("hide", !(ownerUser && t === "pro" && !proFree(cur)));
  $("proBox").classList.toggle("hide", t !== "pro" || noCode());
  $("proFreeNote").classList.toggle("hide", t !== "pro" || !noCode());
  $("proFreeNote").innerHTML = ownerMode && !proFree(cur) ? "👑 Chế độ <b>chủ trang</b>: nạp Pro không cần mã, không tính lượt."
    : "🎁 Bản Pro đang <b>mở miễn phí</b>, không cần mã. Nạp ngay!";
  if (t === "pro" && !codeInfo && !noCode()) {
    lockPro();
    if (cur && siteCfg.packsOn !== false && !pmShown.has(cur.id)) { pmShown.add(cur.id); openProModal(); }   // lan dau chon Pro: hien bang gia (chu trang tat duoc)
    return;
  }   // Pro: phai co ma hop le moi hien thong so
  showTier(t);
}
// Hien huong dan, so do chan, tuy chinh va mo nut nap cho ban t
let shownTier = null;
function showTier(t) {
  $("proWait").classList.add("hide");
  $("erase").closest("label").classList.remove("hide");
  $("infoSec").classList.remove("hide");
  $("reqCard").open = false;
  if (shownTier !== t) { shownTier = t; renderInfo(t); }
  $("dlBox").classList.toggle("hide", t !== "pro");
  $("dlLock").classList.toggle("hide", !(t === "free" && proOn(cur)));
  $("optBox").classList.toggle("hide", !hasOpts);
  if (hasOpts) renderOptions($("optForm"), t, proOn(cur));
  $("go").disabled = false;
  $("go").innerHTML = $("go").dataset.label || goText;
  showQuota();
}
// Chon Pro nhung chua co ma: an het thong so
function lockPro() {
  shownTier = null;
  showQuota();
  $("dlBox").classList.add("hide"); $("dlLock").classList.add("hide");
  $("proWait").classList.remove("hide");
  $("infoSec").classList.add("hide");
  $("reqCard").open = true;
  $("optBox").classList.add("hide");
  $("optForm").innerHTML = "";
  $("erase").closest("label").classList.add("hide");
  $("go").disabled = true;
  $("go").textContent = "Nhập mã Pro để tiếp tục";
}

// ---------- Kiem tra mach ----------
function showFit() {
  const box = $("chkRes");
  if (!chipInfo) { box.classList.add("hide"); return; }
  const i = chipInfo, f = checkFit(i, cur);
  const row = (k, v) => v ? `<tr><td class="muted">${k}</td><td><b>${esc(v)}</b></td></tr>` : "";
  box.innerHTML = `<div class="note ${f.ok ? (f.warn.length ? "warn" : "ok") : "bad"}" style="margin-top:10px">
      ${f.ok ? (f.warn.length ? "⚠️ Mạch dùng được, lưu ý:" : "✅ Mạch phù hợp với dự án này") : "❌ Mạch chưa phù hợp:"}
      ${[...f.problems, ...f.warn].map((x) => `<div>• ${esc(x)}</div>`).join("")}</div>
    <table class="tbl" style="margin-top:6px">${row("Mạch", i.desc)}${row("Chip", i.kind === "esp" ? i.chip : i.chip)}
      ${row("Flash", i.flashMB ? i.flashMB + " MB" : "")}${row("PSRAM", i.kind === "esp" ? (i.psramMB ? i.psramMB + " MB" : "Không thấy") : "")}
      ${row("Tính năng", (i.features || []).join(", "))}${row("MAC", i.mac)}${row("Cổng USB", i.usb + (i.usbName ? " · " + i.usbName : ""))}</table>`;
  box.classList.remove("hide");
}
$("chkBtn").onclick = async () => {
  if (busy) return;
  if (!("serial" in navigator)) return alert("Hãy dùng Chrome hoặc Edge trên máy tính.");
  let port;
  try { port = await navigator.serial.requestPort(); } catch { return; }
  busy = true; $("chkBtn").disabled = true; $("chkBtn").textContent = "Đang kiểm tra…";
  $("chkRes").classList.remove("hide"); $("chkRes").innerHTML = '<div class="note" style="margin-top:10px">Đang đọc chip… nếu lâu quá, giữ <b>BOOT</b>, nhấn <b>RST</b> rồi thả <b>BOOT</b>.</div>';
  try {
    chipInfo = await identify(port, (m) => console.log("[kiem tra]", m));
    savedPort = port;
    showFit();
  } catch (e) {
    $("chkRes").innerHTML = `<div class="note bad" style="margin-top:10px">Không đọc được mạch: ${esc(e.message || e)}</div>`;
  } finally { busy = false; $("chkBtn").disabled = false; $("chkBtn").textContent = "🔍 Kiểm tra mạch"; }
};

// ---------- Huong dan su dung + so do chan (theo ban dang xem) ----------
let infoReq = 0, lastInfo = null;
// Ban Pro (da nhap ma): cho tai so do + huong dan ve may
$("dlPins").onclick = () => lastInfo && downloadPins(lastInfo.g.pins, lastInfo.p, lastInfo.t);
$("dlGuide").onclick = () => lastInfo && downloadGuide(lastInfo.g, lastInfo.p, lastInfo.t, $("dlGuide"));
async function renderInfo(t) {
  const req = ++infoReq, p = cur;
  $("guideBox").innerHTML = $("pinsBox").innerHTML = '<p class="tiny">Đang tải…</p>';
  const g = await loadGuide(p, t);
  if (req !== infoReq) return;                     // khach da doi du an / ban khac
  lastInfo = { p, t, g };
  $("guideBox").innerHTML = guideHtml(g.guide);
  $("pinsBox").innerHTML = pinsHtml(g.pins, p.chip || "ESP32");
}
document.querySelectorAll("#infoSec .tab").forEach((b) => b.onclick = () => {
  document.querySelectorAll("#infoSec .tab").forEach((x) => x.classList.toggle("on", x === b));
  $("guideBox").classList.toggle("hide", b.dataset.tab !== "guide");
  $("pinsBox").classList.toggle("hide", b.dataset.tab !== "pins");
});
document.querySelectorAll("input[name=tier]").forEach((r) => r.onchange = () => setTier(r.value));

// ---------- Kiem tra ma Pro ----------
function codeMsg(t, cls) { const m = $("codeMsg"); m.textContent = t; m.className = "note " + (cls || ""); m.classList.toggle("hide", !t); }
let codeT = 0;
$("code").oninput = () => {
  const el = $("code"), v = normCode(el.value);
  if (el.value !== v) el.value = v;
  const had = !!codeInfo;
  codeInfo = null; clearTimeout(codeT);
  if (had && tier() === "pro") lockPro();          // sua ma -> khoa lai
  if (v.length < 14) { codeMsg(""); return; }
  codeT = setTimeout(() => checkCode(v), 300);
};
async function checkCode(c) {
  codeMsg("Đang kiểm tra mã…");
  try {
    const s = await getDoc(doc(db, "codes", c));
    if (!s.exists()) return codeMsg("Mã không đúng.", "bad");
    const d = s.data();
    if (!d.active) return codeMsg("Mã này đã bị khoá.", "bad");
    if (d.project !== "*" && d.project !== cur.id) return codeMsg("Mã này dành cho dự án khác.", "bad");
    const max = d.maxUses || MAX_USES, left = max - (d.uses || 0);
    codeInfo = { code: c, ...d };
    if (left <= 0) codeMsg(`Mã đã nạp đủ ${max}/${max} mạch. Vẫn nạp lại được cho các mạch đã nạp bằng mã này; mạch mới cần mã mới.`, "warn");
    else codeMsg(`✓ Mã hợp lệ · còn ${left}/${max} mạch (nạp lại mạch cũ không tính thêm)`, "ok");
    $("proGet").classList.add("hide"); $("packs").classList.add("hide");
    if (tier() === "pro") showTier("pro");
  } catch (e) { codeMsg("Không kiểm tra được mã, thử lại.", "bad"); }
}

// ---------- Nap ----------
const logEl = $("log");
const log = (t) => { logEl.textContent += t + "\n"; logEl.scrollTop = 1e9; };
const term = { clean() { logEl.textContent = ""; }, writeLine: log, write: (t) => { logEl.textContent += t; } };
function prog(p, s) { $("bar").style.width = (p * 100).toFixed(1) + "%"; $("pct").textContent = Math.round(p * 100) + "%"; if (s) $("stage").textContent = s; }

class Fail extends Error { constructor(msg, stage) { super(msg); this.stage = stage; } }

async function download(t, onP) {
  const key = `${cur.id}:${t}:${cur[t].ver || ""}:${cur[t].parts.map((p) => p.md5 || p.size).join(",")}`;
  if (fwCache[key]) { onP(1); return fwCache[key].map((f) => ({ data: f.data, address: f.address })); }
  const parts = cur[t].parts, out = [];
  const total = parts.reduce((a, p) => a + p.chunks, 0); let n = 0;
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i], buf = new Uint8Array(p.size); let off = 0;
    for (let j = 0; j < p.chunks; j++) {
      const s = await getDoc(doc(db, "projects", cur.id, t, `${i}_${j}`));
      if (!s.exists()) throw new Fail("Thiếu dữ liệu firmware trên máy chủ", "tải");
      const u8 = s.data().d.toUint8Array(); buf.set(u8, off); off += u8.length;
      onP(++n / total);
    }
    if (off !== p.size || (p.md5 && md5u8(buf) !== p.md5)) throw new Fail("Firmware tải về bị lỗi, thử lại", "tải");
    out.push({ data: buf, address: p.offset });
  }
  fwCache[key] = out;
  return out.map((f) => ({ data: f.data, address: f.address }));
}

// Ban Pro co khoa theo mach (vd Game Khung Long): firmware chua dau "KLKHOA" + khoa + dia chi.
// Tao ban quyen cho DUNG mach nay (theo MAC) va ghi kem; chep flash sang mach khac -> MAC khac -> firmware tu khoa.
async function themBanQuyen(files, mac) {
  const M = [0x4B, 0x4C, 0x4B, 0x48, 0x4F, 0x41, 0, 1];
  for (const f of files) {
    const d = f.data;
    for (let i = d.indexOf(0x4B); i >= 0 && i + 44 <= d.length; i = d.indexOf(0x4B, i + 1)) {
      if (M.some((v, k) => d[i + k] !== v)) continue;
      const m = String(mac || "").split(":").map((h) => parseInt(h, 16));
      if (m.length !== 6 || m.some(isNaN)) throw new Fail("Không đọc được mã MAC của mạch để ghi bản quyền Pro", "bản quyền");
      const key = await crypto.subtle.importKey("raw", d.slice(i + 8, i + 40), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
      const tag = new Uint8Array(await crypto.subtle.sign("HMAC", key, new Uint8Array([...new TextEncoder().encode("khung-long"), ...m])));
      const addr = (d[i + 40] | d[i + 41] << 8 | d[i + 42] << 16 | d[i + 43] << 24) >>> 0;
      const sec = new Uint8Array(4096).fill(0xFF);
      sec.set([0x4B, 0x4C, 0x42, 0x51], 0); sec.set(m, 4); sec.set(tag, 10);
      log("Ghi bản quyền Pro khoá theo mạch này");
      return [...files, { data: sec, address: addr }].sort((a, b) => a.address - b.address);
    }
  }
  return files;
}

$("go").onclick = async () => {
  if (busy || !cur || !tier()) return;
  if (!("serial" in navigator)) return alert("Hãy dùng Chrome hoặc Edge trên máy tính.");
  const t = tier();
  if (t === "pro" && !codeInfo && !noCode()) { codeMsg("Nhập mã Pro hợp lệ trước khi nạp.", "bad"); $("code").focus(); return; }
  const useOpt = !$("optBox").classList.contains("hide");
  const optErr = useOpt ? checkOptions($("optForm")) : "";
  $("optMsg").textContent = optErr; $("optMsg").classList.toggle("hide", !optErr);
  if (optErr) { $("optBox").open = true; $("optMsg").scrollIntoView({ behavior: "smooth", block: "center" }); return; }
  let cfgBlob = null;
  try { cfgBlob = useOpt ? buildConfig($("optForm"), t) : null; } catch (e) { $("optMsg").textContent = e.message; $("optMsg").classList.remove("hide"); return; }

  let qs = { ok: true };
  if (limited(t) && limOn() && !credit) {
    qs = await quotaState();
    if (!qs.ok) { showQuota(); return; }
  }

  let port;
  if (savedPort) port = savedPort;                 // da kiem tra mach -> dung lai cong do, khong hoi lai
  else { try { port = await navigator.serial.requestPort(); } catch { return; } }   // khach bam Huy
  savedPort = null;

  busy = true; const t0 = Date.now();
  const rec = { project: cur.id, tier: t, ver: cur[t]?.ver || "", chip: "", mac: "", ok: false, err: "", stage: "", code: t === "pro" && codeInfo ? codeInfo.code : "" };
  $("go").classList.add("hide"); $("run").classList.remove("hide"); $("done").classList.add("hide");
  term.clean(); prog(0, "Đang kết nối mạch…");
  const lockEls = [...document.querySelectorAll("input,button,select,textarea")].filter((e) => !e.disabled && !e.closest("#fbBox,#fbBtn,#donSec"));   // gop y van gui duoc khi dang nap
  lockEls.forEach((e) => e.disabled = true);

  const transport = new Transport(port, true);
  try {
    const loader = new ESPLoader({ transport, baudrate: 921600, terminal: term });
    rec.stage = "kết nối";
    try { await loader.main(); } catch (e) { throw new Fail("Không kết nối được mạch. Thử giữ BOOT, nhấn RST rồi bấm nạp lại.", "kết nối"); }
    const det = await espDetails(loader);
    rec.chip = det.chip;
    rec.mac = det.mac;
    chipInfo = { ...det, desc: det.desc, usb: "", usbName: "" };
    const fit = checkFit(det, cur);
    if (!fit.ok) throw new Fail(fit.problems.join(" "), "kiểm tra mạch");
    log(`Mạch: ${rec.chip} · MAC ${rec.mac}`);

    if (t === "pro" && !noCode() && !(unlocked && unlocked.code === codeInfo.code && unlocked.project === cur.id)) {
      rec.stage = "kích hoạt";
      prog(0.02, "Đang kích hoạt mã Pro…");
      const max = codeInfo.maxUses || MAX_USES;
      const again = (codeInfo.macs || []).includes(rec.mac);       // mach nay da nap bang ma nay -> khong tru luot
      if (!again && (codeInfo.uses || 0) >= max)
        throw new Fail(`Mã đã nạp đủ ${max} mạch, mạch này là mạch mới. Liên hệ để được cấp mã mới.`, "kích hoạt");
      try {
        const upd = again ? { uid, lastMac: rec.mac, usedAt: serverTimestamp() }
          : { uid, lastMac: rec.mac, macs: arrayUnion(rec.mac), usedAt: serverTimestamp(), uses: increment(1) };
        await updateDoc(doc(db, "codes", codeInfo.code), upd);
        await setDoc(doc(db, "unlocks", uid), { code: codeInfo.code, project: cur.id, at: serverTimestamp() });
      } catch (e) { throw new Fail("Kích hoạt mã không thành công (mã sai, bị khoá hoặc đã hết lượt).", "kích hoạt"); }
      unlocked = { code: codeInfo.code, project: cur.id };
      if (!again) { codeInfo.uses = (codeInfo.uses || 0) + 1; codeInfo.macs = [...(codeInfo.macs || []), rec.mac]; }
      log(again ? "Mạch này đã nạp bằng mã này trước đó: không tính thêm lượt" : `Đã dùng mã: ${codeInfo.uses}/${max} mạch`);
    }

    if (limited(t) && limOn() && !credit) {
      rec.stage = "lượt nạp";
      try { await consumeQuota(qs); } catch (e) { throw new Fail("Đã hết lượt nạp miễn phí trong khung giờ này. Đợi hết đếm ngược rồi nạp tiếp.", "lượt nạp"); }
      credit = true;
    }

    if (t === "pro" && rec.mac) {                    // giay phep Pro cho dung mach nay (may kiem tra, chep firmware sang mach khac se bi khoa)
      try {
        await setDoc(doc(db, "lic", rec.mac.replace(/:/g, "").toLowerCase()),
          { code: codeInfo?.code || "", project: cur.id, m: rec.mac, at: serverTimestamp() });
        log("Đã ghi bản quyền Pro cho mạch này");
      } catch (e) { log("Cảnh báo: chưa ghi được bản quyền Pro (" + (e.code || e.message) + ")"); }
    }

    rec.stage = "tải";
    let files = attachConfig(await download(t, (p) => prog(0.03 + p * 0.12, "Đang tải firmware…")), cfgBlob);
    if (cfgBlob) log("Ghi kèm cấu hình tùy chỉnh của bạn");
    if (t === "pro") files = await themBanQuyen(files, rec.mac);

    rec.stage = "nạp";
    const sizes = files.map((f) => f.data.length), all = sizes.reduce((a, b) => a + b, 0);
    await loader.writeFlash({
      fileArray: files, flashMode: "keep", flashFreq: "keep", flashSize: "keep",
      eraseAll: $("erase").checked, compress: true,
      reportProgress: (i, w, tot) => {
        const before = sizes.slice(0, i).reduce((a, b) => a + b, 0);
        prog(0.15 + 0.85 * ((before + (w / tot) * sizes[i]) / all), "Đang nạp…");
      },
      calculateMD5Hash: md5u8,
    });
    rec.stage = "khởi động";
    await loader.after("hard_reset");
    rec.ok = true; rec.stage = "xong";
    prog(1, "Hoàn tất");
    $("run").classList.add("hide");
    $("done").innerHTML = `<div class="ic">🎉</div><h3>Nạp thành công!</h3>
      <p class="muted small">Mạch đang khởi động lại. Nếu màn hình chưa sáng, nhấn nút <b>RST</b> một lần.</p>
      ${t === "pro" && codeInfo ? `<p class="pill pro">Mã Pro còn ${Math.max(0, (codeInfo.maxUses || MAX_USES) - (codeInfo.uses || 0))}/${codeInfo.maxUses || MAX_USES} mạch</p><br><br>` : ""}
      <button class="btn pri" id="again">🔁 Nạp mạch khác</button>${t === "free" || proFree(cur) ? donateMini() : ""}`;
    $("done").classList.remove("hide");
    credit = false;
    $("again").onclick = nextBoard;
    const dl = $("done").querySelector(".don-link");
    if (dl) dl.onclick = (e) => { e.preventDefault(); $("donSec").scrollIntoView({ behavior: "smooth", block: "center" }); $("donSec").classList.add("flash-hl"); setTimeout(() => $("donSec").classList.remove("flash-hl"), 1600); };
  } catch (e) {
    rec.err = String(e?.message || e).slice(0, 300);
    if (e instanceof Fail) rec.stage = e.stage;
    log("LỖI: " + rec.err);
    $("stage").textContent = "Lỗi";
    $("done").innerHTML = `<div class="ic">⚠️</div><h3>Chưa nạp được</h3><p class="note bad">${esc(e instanceof Fail ? e.message : "Lỗi khi " + rec.stage + ": " + rec.err)}</p>
      <button class="btn" id="retry">Thử lại</button>`;
    $("done").classList.remove("hide");
    $("retry").onclick = () => { $("done").classList.add("hide"); $("run").classList.add("hide"); $("go").classList.remove("hide"); showQuota(); };
  } finally {
    try { await transport.disconnect(); } catch {}
    busy = false;
    lockEls.forEach((e) => e.disabled = false);
    if (!rec.ok) showQuota();
    rec.ms = Date.now() - t0;
    if (uid) addDoc(collection(db, "flashes"), { ...rec, uid, at: serverTimestamp() }).catch((e) => console.warn("flash log", e));
  }
};

// Nap mach tiep theo ngay tren trang: giu du an, phien ban, tuy chinh va firmware da tai
function nextBoard() {
  $("done").classList.add("hide"); $("run").classList.add("hide"); $("go").classList.remove("hide");
  chipInfo = null; savedPort = null; showFit();
  prog(0, "Chuẩn bị…");
  $("flashSec").scrollIntoView({ behavior: "smooth", block: "start" });
  showQuota();
}

// ---------- Gop y cua khach ----------
let fbStars = 0;
$("fbBtn").onclick = () => { $("fbBox").classList.toggle("hide"); if (!$("fbBox").classList.contains("hide")) $("fbMsg").focus(); };
$("fbX").onclick = () => $("fbBox").classList.add("hide");
document.querySelectorAll("#fbStars button").forEach((b) => b.onclick = () => {
  fbStars = +b.dataset.s;
  document.querySelectorAll("#fbStars button").forEach((x) => x.classList.toggle("on", +x.dataset.s <= fbStars));
});
$("fbSend").onclick = async () => {
  const msg = $("fbMsg").value.trim(), out = $("fbMsgOut");
  if (!msg && !fbStars) { out.textContent = "Chấm sao hoặc viết vài chữ nhé."; return; }
  let last = 0; try { last = +localStorage.getItem("fb_last") || 0; } catch {}
  if (Date.now() - last < 60000) { out.textContent = "Bạn vừa gửi rồi, đợi 1 phút rồi gửi tiếp nhé."; return; }
  if (!uid) { out.textContent = "Chưa kết nối được, thử tải lại trang."; return; }
  $("fbSend").disabled = true; out.textContent = "Đang gửi…";
  try {
    const d = deviceInfo();
    await addDoc(collection(db, "feedback"), { uid, at: serverTimestamp(), msg: msg.slice(0, 1000),
      contact: $("fbContact").value.trim().slice(0, 100), stars: fbStars, project: cur?.id || "",
      device: `${d.device} · ${d.os} · ${d.browser}`.slice(0, 80) });
    try { localStorage.setItem("fb_last", String(Date.now())); } catch {}
    $("fbMsg").value = ""; out.textContent = "✅ Đã gửi. Cảm ơn bạn nhiều!";
    setTimeout(() => $("fbBox").classList.add("hide"), 1800);
  } catch (e) { out.textContent = "Gửi không được, thử lại sau nhé."; }
  $("fbSend").disabled = false;
};

// Chu trang: mac dinh thu nhu khach (phai nhap ma). Bam "Bo qua ma" de nap Pro khong can ma
$("ownerSkip").onclick = (e) => { e.preventDefault(); ownerMode = !ownerMode;
  $("ownerSkip").textContent = ownerMode ? "↩ Thử lại như khách (cần mã)" : "👑 Chủ trang: bỏ qua mã";
  if (tier() === "pro") setTier("pro"); };
