/* ============================================================
   Hydrix — منطق التطبيق
   - راوتر شاشات + شريط تنقل سفلي
   - محاكاة حساسات عند عدم الاتصال (وضع العرض التوضيحي)
   - ربط BLE حقيقي عند توصيل ESP32
   - طقس فعلي من Open-Meteo + رصد احتمال المطر
   - تحليل صورة النبات محلياً (فحص ألوان الورقة)
   - تحكم صوتي عربي
   ============================================================ */

const $ = (id) => document.getElementById(id);
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

/* ---------------- الحالة العامة ---------------- */
const state = {
  connected: false,
  pumpOn: false,
  smartActive: JSON.parse(localStorage.getItem("hydrix_smart") ?? "true"),
  moisture: 45,
  temp: 28,
  hum: 55,
  rain: false,                 // مطر مرصود من حساس المشروع
  rainForecast: null,          // احتمال المطر % من الأرصاد
  timedMin: 10,
  timedEndsAt: null,
  lastStopTs: Number(localStorage.getItem("hydrix_lastStop")) || Date.now() - 15 * 60000,
  pumpStartTs: null,
  waterSaved: 3.2,
  lastPlantImage: null,
  thresholds: JSON.parse(localStorage.getItem("hydrix_th") ?? '{"on":40,"off":60}'),
  notifyOn: false,
  log: JSON.parse(localStorage.getItem("hydrix_log") ?? "[]"),
  samples: JSON.parse(localStorage.getItem("hydrix_samples") ?? "[]"),
  lastStartMeta: null,
  lastSampleTs: 0,
  lastLowAlert: 0,
  farmName: localStorage.getItem("hydrix_farm") || "",
  crop: localStorage.getItem("hydrix_crop") || "",
};
// state.waterSaved أصبح محسوباً من سجل الري الذكي (computeWaterSaved)

function persist() {
  localStorage.setItem("hydrix_smart", JSON.stringify(state.smartActive));
  localStorage.setItem("hydrix_lastStop", String(state.lastStopTs));
}

/* ---------------- التوست ---------------- */
let toastTimer = null;
function toast(msg, ms = 2600) {
  const el = $("toast");
  el.textContent = msg;
  el.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove("show"), ms);
}

/* ---------------- الراوتر ---------------- */
const SCREENS = ["welcome", "dashboard", "manual", "timed", "smart", "plant", "camera", "history", "settings", "about"];
const NAV_SCREENS = new Set(["dashboard", "history", "plant", "about"]);

function navigate() {
  let name = location.hash.replace("#", "") || "welcome";
  if (!SCREENS.includes(name)) name = "welcome";
  SCREENS.forEach((s) => $("screen-" + s).classList.toggle("active", s === name));
  $("bottomnav").hidden = !NAV_SCREENS.has(name);
  document.querySelectorAll(".nav-item").forEach((a) =>
    a.classList.toggle("active", a.dataset.screen === name)
  );
  window.scrollTo({ top: 0 });
  if (name === "dashboard") loadWeatherOnce();
  if (name === "history") renderHistory();
  if (name === "settings") syncSettingsUI();
  if (name === "camera") startCamera();
  else stopCamera();
}
window.addEventListener("hashchange", navigate);
$("btnStart").addEventListener("click", () => { location.hash = "dashboard"; });

/* ---------------- تنسيق الوقت ---------------- */
function fmtElapsed(ms) {
  const s = Math.floor(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}
function fmtSince(ts) {
  const min = Math.floor((Date.now() - ts) / 60000);
  if (min < 1) return "الآن";
  if (min < 60) return `منذ ${min} دقيقة`;
  const h = Math.floor(min / 60);
  if (h < 24) return `منذ ${h} ساعة`;
  return `منذ ${Math.floor(h / 24)} يوم`;
}

/* ---------------- أوامر المضخة ---------------- */
function sendBLE(cmd) {
  if (HydrixBLE.isConnected()) {
    HydrixBLE.send(cmd);
    return true;
  }
  return false;
}

const MODE_NAMES = { manual: "يدوي", timed: "مؤقت", smart: "ذكي", device: "من الجهاز" };

function logEvent(e, m, d) {
  state.log.unshift({ t: Date.now(), e, m, d });
  state.log = state.log.slice(0, 200);
  localStorage.setItem("hydrix_log", JSON.stringify(state.log));
}

function notify(body) {
  if (!state.notifyOn || !("Notification" in window) || Notification.permission !== "granted") return;
  try { new Notification("Hydrix", { body }); } catch { /* الإشعارات غير متاحة */ }
}

function setPump(on, { quiet = false, source = "manual", auto = false, ble = true } = {}) {
  if (state.pumpOn === on) return;
  state.pumpOn = on;
  if (on) {
    state.pumpStartTs = Date.now();
    state.lastStartMeta = { t: Date.now(), m: source };
    logEvent("start", source);
    if (auto) notify(`بدأ الري الذكي تلقائياً — رطوبة التربة ${Math.round(state.moisture)}%`);
  } else {
    const dur = state.pumpStartTs ? Date.now() - state.pumpStartTs : null;
    state.lastStopTs = Date.now();
    state.pumpStartTs = null;
    logEvent("stop", state.lastStartMeta?.m || source, dur);
    state.lastStartMeta = null;
    persist();
    if (auto) notify(`اكتمل الري وتوقفت المضخة — المدة ${Math.round((dur || 0) / 60000)} دقيقة`);
  }
  // في الري المؤقت الأمر T هو اللي بيشغل المضخة على الجهاز — إرسال ON بعده يلغي المؤقت
  const sent = ble ? sendBLE(on ? "ON" : "OFF") : false;
  if (!quiet) {
    toast(
      on
        ? (sent ? "تم تشغيل الري وأُرسل الأمر عبر البلوتوث" : "تم تشغيل الري (وضع تجريبي)")
        : (sent ? "تم إيقاف الري وأُرسل الأمر عبر البلوتوث" : "تم إيقاف الري")
    );
  }
  render();
}

/* ---------------- عناصر التحكم ---------------- */
$("btnPumpOn").addEventListener("click", () => setPump(true, { source: "manual" }));
$("btnPumpOff").addEventListener("click", () => setPump(false, { source: "manual" }));

// الري المؤقت
document.querySelectorAll(".dur-chip").forEach((chip) => {
  chip.addEventListener("click", () => {
    document.querySelectorAll(".dur-chip").forEach((c) => c.classList.remove("selected"));
    chip.classList.add("selected");
    state.timedMin = Number(chip.dataset.min);
    $("btnTimedStart").textContent = `بدء الري — ${state.timedMin} دقائق`;
  });
});

$("btnTimedStart").addEventListener("click", () => {
  state.timedEndsAt = Date.now() + state.timedMin * 60000;
  sendBLE("T" + state.timedMin);
  // الأمر T10 بيشغل المضخة على الجهاز — منبعتش ON عشان منلغيش المؤقت هناك
  if (!state.pumpOn) setPump(true, { quiet: true, source: "timed", ble: false });
  $("timedRun").classList.remove("hidden");
  $("btnTimedStart").classList.add("hidden");
  $("btnTimedStop").classList.remove("hidden");
  toast(`بدأ الري المؤقت لمدة ${state.timedMin} دقائق`);
});

function endTimed(msg) {
  state.timedEndsAt = null;
  if (state.pumpOn) setPump(false, { quiet: true });
  $("timedRun").classList.add("hidden");
  $("btnTimedStart").classList.remove("hidden");
  $("btnTimedStop").classList.add("hidden");
  if (msg) toast(msg);
}
$("btnTimedStop").addEventListener("click", () => endTimed("تم إيقاف الري المؤقت"));

// الري الذكي
$("btnSmartToggle").addEventListener("click", () => {
  state.smartActive = !state.smartActive;
  persist();
  sendBLE(state.smartActive ? "SMART_ON" : "SMART_OFF");
  if (!state.smartActive && state.pumpOn) setPump(false, { quiet: true });
  toast(state.smartActive ? "تم تفعيل الري الذكي" : "تم إيقاف الري الذكي");
  render();
});

/* ---------------- البلوتوث ---------------- */
$("btChip").addEventListener("click", async () => {
  if (HydrixBLE.isConnected()) {
    HydrixBLE.disconnect();
    return;
  }
  if (!HydrixBLE.supported()) {
    toast("البلوتوث غير مدعوم هنا — افتح التطبيق بـ Chrome على أندرويد، أو اعرضه في الوضع التجريبي");
    return;
  }
  try {
    toast("جارٍ الاتصال بجهاز Hydrix…");
    await HydrixBLE.connect();
  } catch (err) {
    if (err && err.name === "NotFoundError") toast("لم يتم اختيار جهاز");
    else toast("تعذر الاتصال: " + (err.message || err.name));
  }
});

HydrixBLE.onStateChange = (connected) => {
  state.connected = connected;
  $("btDot").classList.toggle("dot-green", connected);
  $("btDot").classList.toggle("dot-red", !connected);
  $("btChipText").textContent = connected ? "متصل" : "ربط البلوتوث";
  toast(connected ? "تم الاتصال بجهاز Hydrix عبر البلوتوث" : "انقطع الاتصال بالجهاز");
  if (connected) {
    // مزامنة حدود الري الذكي مع الجهاز
    setTimeout(() => sendBLE(`TH:${state.thresholds.on},${state.thresholds.off}`), 600);
  }
  render();
};

HydrixBLE.onMessage = (data) => {
  if (typeof data !== "object") return;
  if (data.moist !== undefined) state.moisture = clamp(Number(data.moist), 0, 100);
  if (data.temp !== undefined) state.temp = Number(data.temp);
  if (data.hum !== undefined) state.hum = Number(data.hum);
  if (data.rain !== undefined) state.rain = !!Number(data.rain);
  if (Array.isArray(data.th) && data.th.length === 2) {
    state.thresholds = { on: Number(data.th[0]), off: Number(data.th[1]) };
    localStorage.setItem("hydrix_th", JSON.stringify(state.thresholds));
    $("thOn").value = state.thresholds.on;
    $("thOff").value = state.thresholds.off;
    $("thOnVal").textContent = state.thresholds.on + "%";
    $("thOffVal").textContent = state.thresholds.off + "%";
  }
  if (data.pump !== undefined) {
    const on = !!Number(data.pump);
    if (on !== state.pumpOn) {
      const wasSmart = Number(data.smart) === 1;
      state.pumpOn = on;
      if (on) {
        state.pumpStartTs = Date.now();
        state.lastStartMeta = { t: Date.now(), m: "device" };
        logEvent("start", "device");
        if (wasSmart) notify(`الري الذكي شغّل المضخة — رطوبة التربة ${Math.round(state.moisture)}%`);
      } else {
        const dur = state.pumpStartTs ? Date.now() - state.pumpStartTs : null;
        state.lastStopTs = Date.now();
        state.pumpStartTs = null;
        logEvent("stop", state.lastStartMeta?.m || "device", dur);
        state.lastStartMeta = null;
        if (wasSmart) notify("الري الذكي أوقف المضخة");
      }
    }
  }
  render();
};

/* ---------------- الطقس الفعلي (Open-Meteo) ---------------- */
let weatherLoaded = false;
async function loadWeatherOnce() {
  if (weatherLoaded) return;
  weatherLoaded = true;

  let lat = 30.0444, lon = 31.2357; // القاهرة كخيار افتراضي
  try {
    const pos = await new Promise((res, rej) =>
      navigator.geolocation
        ? navigator.geolocation.getCurrentPosition(res, rej, { timeout: 3500 })
        : rej(new Error("no geo"))
    );
    lat = pos.coords.latitude; lon = pos.coords.longitude;
  } catch { /* نستخدم الإحداثيات الافتراضية */ }

  try {
    const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}` +
      `&current=temperature_2m,relative_humidity_2m&hourly=precipitation_probability&forecast_days=1`;
    const res = await fetch(url);
    const w = await res.json();
    if (!HydrixBLE.isConnected()) {
      if (w.current?.temperature_2m !== undefined) state.temp = Math.round(w.current.temperature_2m);
      if (w.current?.relative_humidity_2m !== undefined) state.hum = Math.round(w.current.relative_humidity_2m);
    }
    const probs = (w.hourly?.precipitation_probability || []).slice(0, 12).filter((p) => p !== null);
    state.rainForecast = probs.length ? Math.max(...probs) : 0;
    $("weatherSrc").textContent = "بيانات الأرصاد الفعلية";
    $("weatherSrc").classList.add("on");
  } catch {
    /* نبقي القيم التجريبية */
  }
  render();
}

/* ---------------- تحليل النبات (فحص ألوان محلي) ---------------- */
$("btnChoose").addEventListener("click", () => $("plantFile").click());
$("plantFile").addEventListener("change", (e) => {
  const file = e.target.files?.[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => handlePlantImage(reader.result);
  reader.readAsDataURL(file);
  e.target.value = "";
});

function handlePlantImage(dataUrl) {
  const img = new Image();
  img.onload = () => {
    $("plantEmpty").classList.add("hidden");
    $("plantResult").classList.add("hidden");
    $("aiResult").classList.add("hidden");
    $("aiError").classList.add("hidden");
    $("aiCard").classList.remove("hidden");
    $("plantPreview").classList.remove("hidden");
    $("plantImg").src = img.src;
    $("analyzing").classList.remove("hidden");
    state.lastPlantImage = dataUrl;
    setTimeout(() => {
      const r = analyzeImage(img);
      $("analyzing").classList.add("hidden");
      showPlantResult(r);
    }, 1400);
  };
  img.src = dataUrl;
}

function analyzeImage(img) {
  const size = 128;
  const cv = $("analyzeCanvas");
  cv.width = size; cv.height = size;
  const ctx = cv.getContext("2d", { willReadFrequently: true });
  // قص مركزي لملء المربع
  const side = Math.min(img.width, img.height);
  ctx.drawImage(img, (img.width - side) / 2, (img.height - side) / 2, side, side, 0, 0, size, size);
  const { data } = ctx.getImageData(0, 0, size, size);

  let green = 0, yellow = 0, brown = 0;
  const total = size * size;
  for (let i = 0; i < data.length; i += 4) {
    const r = data[i], g = data[i + 1], b = data[i + 2];
    const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
    if (mx < 45 || (mn > 205)) continue;          // ظلال وخلفيات فاتحة جداً
    if (g > 90 && g > r * 1.12 && g > b * 1.12) green++;
    else if (r > 115 && g > 95 && b < 115 && g > b * 1.25 && Math.abs(r - g) < 65) yellow++;
    else if (r > 55 && g < r && g > b && (r - g) > 18 && (g - b) > 8) brown++;
  }
  const plant = green + yellow + brown;
  const pct = (v, base) => (base ? Math.round((v / base) * 100) : 0);
  const base = plant || total;
  return {
    green: pct(green, base),
    yellow: pct(yellow, base),
    brown: pct(brown, base),
    plantDetected: plant > total * 0.04,
  };
}

function showPlantResult(r) {
  $("plantResult").classList.remove("hidden");
  $("ratioGreen").style.width = r.green + "%";
  $("ratioYellow").style.width = r.yellow + "%";
  $("ratioBrown").style.width = r.brown + "%";
  $("ratioGreenVal").textContent = r.green + "%";
  $("ratioYellowVal").textContent = r.yellow + "%";
  $("ratioBrownVal").textContent = r.brown + "%";

  const verdict = $("plantVerdict");
  const advice = $("plantAdvice");
  if (!r.plantDetected) {
    verdict.textContent = "لم يتم التعرف على نبات واضح في الصورة";
    advice.textContent = "جرّب التقاط صورة أقرب للأوراق وبإضاءة أفضل، ثم أعد التحليل.";
  } else if (r.brown >= 12) {
    verdict.textContent = "توجد بقع بنية على الأوراق — النبات يحتاج تدخل 🍂";
    advice.textContent = "البقع البنية قد تدل على مرض فطري أو نقص ري. أزل الأوراق المصابة، وتأكد من انتظام الري، وتابع الصورة لاحقاً للمقارنة.";
  } else if (r.yellow >= 25) {
    verdict.textContent = "اصفرار في الأوراق — يحتاج متابعة ⚠️";
    advice.textContent = "الاصفرار قد ينتج عن ري زائد أو نقص عناصر غذائية. راقب رطوبة التربة من لوحة التحكم واضبط جدول الري.";
  } else if (r.green >= 60) {
    verdict.textContent = "النبات في حالة جيدة";
    advice.textContent = `نسبة الأوراق السليمة ${r.green}% — استمر في نفس نظام الري الحالي وتابع الحالة دورياً.`;
  } else {
    verdict.textContent = "حالة النبات تحتاج متابعة 👀";
    advice.textContent = "نسبة الخضرة أقل من المعتاد. تأكد من الري والإضاءة، وأعد التصوير بعد يومين للمقارنة.";
  }
}

/* ---------------- الكاميرا ---------------- */
let camStream = null;
let camFacing = "environment";

function showCamError(msg) {
  stopCamera();
  $("camVideo").classList.add("hidden");
  $("camErrorText").textContent = msg;
  $("camError").classList.remove("hidden");
}

async function startCamera() {
  $("camError").classList.add("hidden");
  $("camVideo").classList.remove("hidden");
  const video = $("camVideo");
  if (!navigator.mediaDevices?.getUserMedia) {
    showCamError("الكاميرا غير متاحة هنا — افتح التطبيق على HTTPS من Chrome (كمبيوتر أو أندرويد)");
    return;
  }
  try {
    camStream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: camFacing, width: { ideal: 1280 }, height: { ideal: 1280 } },
      audio: false,
    });
    video.srcObject = camStream;
  } catch (err) {
    showCamError(
      err.name === "NotAllowedError"
        ? "اسمح بإذن الكاميرا من المتصفح عشان تقدر تصوّر النبات"
        : "تعذر تشغيل الكاميرا: " + (err.message || err.name)
    );
  }
}

function stopCamera() {
  if (camStream) {
    camStream.getTracks().forEach((t) => t.stop());
    camStream = null;
  }
}

$("btnCamRetry").addEventListener("click", startCamera);
$("btnCamFlip").addEventListener("click", () => {
  camFacing = camFacing === "environment" ? "user" : "environment";
  startCamera();
});
$("btnOpenCamera").addEventListener("click", () => { location.hash = "camera"; });

// زر التصوير: يلتقط مربعاً 640px من منتصف الفيديو ويعود لشاشة التحليل
$("btnCamShot").addEventListener("click", () => {
  const video = $("camVideo");
  if (!camStream || video.readyState < 2 || !video.videoWidth) {
    toast("الكاميرا مش جاهزة بعد — استنى ثانية أو اسمح بالإذن");
    return;
  }
  const side = Math.min(video.videoWidth, video.videoHeight);
  const cv = document.createElement("canvas");
  cv.width = 640; cv.height = 640;
  cv.getContext("2d").drawImage(
    video,
    (video.videoWidth - side) / 2, (video.videoHeight - side) / 2, side, side,
    0, 0, 640, 640
  );
  const dataUrl = cv.toDataURL("image/jpeg", 0.9);
  stopCamera();
  location.hash = "plant";
  handlePlantImage(dataUrl);
  toast("تم التقاط الصورة");
});

// من المعرض (بدون فرض الكاميرا)
$("btnCamGallery").addEventListener("click", () => {
  const input = document.createElement("input");
  input.type = "file";
  input.accept = "image/*";
  input.addEventListener("change", () => {
    const file = input.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      stopCamera();
      location.hash = "plant";
      handlePlantImage(reader.result);
    };
    reader.readAsDataURL(file);
  });
  input.click();
});

/* ---------------- التحليل بالذكاء الاصطناعي (Gemini) ---------------- */
$("btnAiAnalyze").addEventListener("click", async () => {
  if (!state.lastPlantImage) { toast("اختر أو صوّر صورة للنبات الأول"); return; }
  let key = localStorage.getItem("hydrix_ai_key");
  if (!key) {
    $("aiKeyRow").classList.remove("hidden");
    $("aiKeyInput").focus();
    toast("حط مفتاح Gemini المجاني مرة واحدة بس — واللينك تحت");
    return;
  }
  await runAiAnalysis(key);
});

$("btnAiSaveKey").addEventListener("click", async () => {
  const key = $("aiKeyInput").value.trim();
  if (!key) { toast("الصق المفتاح الأول"); return; }
  localStorage.setItem("hydrix_ai_key", key);
  $("aiKeyRow").classList.add("hidden");
  toast("تم حفظ المفتاح على جهازك 🔑");
  await runAiAnalysis(key);
});

async function runAiAnalysis(key) {
  const btn = $("btnAiAnalyze");
  const errEl = $("aiError");
  btn.disabled = true;
  btn.textContent = "جارٍ تحليل الصورة بالذكاء الاصطناعي…";
  errEl.classList.add("hidden");
  $("aiResult").classList.add("hidden");

  try {
    const result = await analyzeWithAI(key);
    showAiResult(result);
  } catch (err) {
    errEl.textContent = "تعذر التحليل: " + err.message;
    errEl.classList.remove("hidden");
    if (/المفتاح/.test(err.message)) {
      $("aiKeyRow").classList.remove("hidden");
    }
  } finally {
    btn.disabled = false;
    btn.textContent = "حلل الصورة بالذكاء الاصطناعي";
  }
}

async function analyzeWithAI(key) {
  const b64 = state.lastPlantImage.split(",")[1];
  const cropLine = state.crop ? `النبات المزروع معروف من المزارع وهو: ${state.crop} — اعتمد على ذلك في التشخيص. ` : "";
  const prompt =
    "أنت خبير زراعي متخصص في تشخيص أمراض النبات. حلل صورة النبات هذه ورد بـ JSON فقط بدون أي نص إضافي أو علامات تنصيص محيطة، بالشكل التالي: " +
    '{"plant":"وصف مختصر للنبات","status":"جيدة" أو "تحتاج متابعة" أو "يوجد مشكلة","problem":"اسم المشكلة بالعربي أو لا يوجد","confidence":رقم من 0 إلى 100,' +
    '"signs":"وصف العلامات الظاهرة في الصورة بسطر واحد","advice":["نصيحة عملية 1","نصيحة عملية 2","نصيحة عملية 3"]} ' +
    cropLine +
    "اكتب كل النصوص بالعربية الواضحة لمزارع مبتدئ.";
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${encodeURIComponent(key)}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }, { inline_data: { mime_type: "image/jpeg", data: b64 } }] }],
      }),
    }
  );
  if (!res.ok) {
    if (res.status === 400 || res.status === 403) throw new Error("المفتاح غير صحيح أو غير مفعل");
    if (res.status === 429) throw new Error("تجاوزت الحد المجاني للطلبات — جرب بعد دقائق");
    if (res.status === 503) throw new Error("الخدمة مشغولة حالياً — جرب تاني");
    throw new Error("خطأ من الخدمة (" + res.status + ")");
  }
  const data = await res.json();
  const text = (data.candidates?.[0]?.content?.parts || []).map((p) => p.text || "").join("");
  const json = JSON.parse(text.replace(/```json|```/g, "").trim());
  if (!json.status) throw new Error("رد غير مفهوم من النموذج");
  return json;
}

function showAiResult(r) {
  $("aiResult").classList.remove("hidden");
  const status = $("aiStatus");
  status.textContent = r.status || "—";
  status.className = "pill " + (r.status === "جيدة" ? "pill-ok" : r.status === "يوجد مشكلة" ? "pill-warn" : "pill-off");
  $("aiProblem").textContent = r.problem && r.problem !== "لا يوجد" ? r.problem : "لا توجد مشكلة ظاهرة";
  const conf = clamp(Number(r.confidence) || 0, 0, 100);
  $("aiConf").style.width = conf + "%";
  $("aiConfVal").textContent = conf + "%";
  $("aiSigns").textContent = r.signs || "";
  $("aiAdvice").innerHTML = "";
  (r.advice || []).slice(0, 5).forEach((tip) => {
    const li = document.createElement("li");
    li.textContent = tip;
    $("aiAdvice").appendChild(li);
  });
  if (r.plant) $("aiSigns").textContent = `النبات: ${r.plant} — ` + (r.signs || "");
}

/* ---------------- التحكم الصوتي ---------------- */
(function initVoice() {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) return; // يبقى الزر مخفياً
  const fab = $("btnVoice");
  fab.hidden = false;
  let rec = null;

  fab.addEventListener("click", () => {
    if (rec) { rec.stop(); rec = null; return; }
    rec = new SR();
    rec.lang = "ar-EG";
    fab.classList.add("listening");
    toast("تكلّم الآن… مثال: «اسقي النبات» أو «اقفل الري»");
    rec.onresult = (e) => {
      const t = e.results[0][0].transcript;
      if (/اسق|إسق|شغل|ري /.test(t) || t.includes("اسقي")) {
        setPump(true); toast(`سمعت: «${t}» — تم تشغيل الري`);
      } else if (/اقفل|إيقاف|وقف|ايقاف/.test(t)) {
        setPump(false); toast(`سمعت: «${t}» — تم إيقاف الري`);
      } else if (/ذكي/.test(t)) {
        $("btnSmartToggle").click();
      } else {
        toast(`سمعت: «${t}» — لم أفهم الأمر`);
      }
    };
    rec.onerror = () => toast("تعذر سماع الصوت — تأكد من إذن الميكروفون");
    rec.onend = () => { rec = null; fab.classList.remove("listening"); };
    rec.start();
  });
})();

/* ---------------- الحلقة الزمنية (محاكاة + مؤقت + تسجيل) ---------------- */
setInterval(() => {
  const now = Date.now();

  // انتهاء الري المؤقت
  if (state.timedEndsAt) {
    const remain = state.timedEndsAt - now;
    if (remain <= 0) {
      endTimed("انتهت مدة الري وتوقف النظام تلقائياً");
    } else {
      const total = state.timedMin * 60000;
      $("timedCountdown").textContent = fmtElapsed(remain);
      $("timedBar").style.width = ((1 - remain / total) * 100).toFixed(1) + "%";
    }
  }

  // محاكاة الحساسات عند عدم الاتصال بجهاز حقيقي
  if (!HydrixBLE.isConnected()) {
    if (state.pumpOn) {
      state.moisture = clamp(state.moisture + 0.35, 0, 100);
    } else {
      state.moisture = clamp(state.moisture - 0.02, 0, 100);
    }
    state.temp = Math.round((28 + Math.sin(now / 60000) * 1.5) * 10) / 10;
    state.hum = Math.round(55 + Math.cos(now / 45000) * 4);

    // منطق الري الذكي (محلياً في الوضع التجريبي)
    if (state.smartActive) {
      const rainHolds = state.rain || (state.rainForecast !== null && state.rainForecast >= 55);
      if (!state.pumpOn && state.moisture < state.thresholds.on && !rainHolds)
        setPump(true, { quiet: true, source: "smart", auto: true });
      else if (state.pumpOn && (state.moisture >= state.thresholds.off || rainHolds))
        setPump(false, { quiet: true, source: "smart", auto: true });
    }
  }

  // تنبيه انخفاض الرطوبة الخطير (مرة كل ساعة كحد أقصى)
  if (state.moisture < 30 && now - state.lastLowAlert > 3600000) {
    state.lastLowAlert = now;
    notify(`⚠️ رطوبة التربة منخفضة جداً (${Math.round(state.moisture)}%) — النبات عطشان!`);
  }

  // تسجيل عينة رطوبة كل 5 دقائق للرسم البياني
  if (now - state.lastSampleTs > 300000) {
    state.lastSampleTs = now;
    state.samples.push({ t: now, m: Math.round(state.moisture) });
    state.samples = state.samples.slice(-288); // 24 ساعة
    localStorage.setItem("hydrix_samples", JSON.stringify(state.samples));
  }

  render();
}, 1000);

/* ---------------- العرض ---------------- */
function render() {
  // بطاقة التربة
  $("soilMoisture").textContent = Math.round(state.moisture);
  $("moistFill").style.width = state.moisture + "%";
  $("moistMarker").style.insetInlineStart = state.moisture + "%";
  const pill = $("soilStatusPill");
  if (state.moisture < 40) { pill.textContent = "جافة"; pill.className = "pill pill-warn"; $("soilNote").textContent = "التربة جافة — يُنصح بتشغيل الري"; }
  else if (state.moisture <= 70) { pill.textContent = "جيدة"; pill.className = "pill pill-ok"; $("soilNote").textContent = "الرطوبة مناسبة — التربة في حالة جيدة"; }
  else { pill.textContent = "مشبعة"; pill.className = "pill pill-ok"; $("soilNote").textContent = "التربة مشبعة بالرطوبة — لا حاجة للري"; }

  // الطقس
  $("tempVal").textContent = state.temp;
  $("humVal").textContent = state.hum;
  const rainChip = $("rainChip");
  if (state.rainForecast !== null && state.rainForecast >= 40) {
    rainChip.classList.remove("hidden");
    $("rainChipText").textContent = `احتمال مطر ${state.rainForecast}% خلال الساعات القادمة`;
  } else if (state.rain) {
    rainChip.classList.remove("hidden");
    $("rainChipText").textContent = "حساس المطر يرصد سقوط مطر الآن";
  }

  // آخر عملية ري
  $("lastIrrigation").textContent = state.pumpOn ? "الآن — جاري الري" : fmtSince(state.lastStopTs);

  // الري اليدوي
  $("manualStatus").textContent = state.pumpOn ? "حالة الري: جاري الري" : "حالة الري: متوقف";
  $("manualDot").className = "dot " + (state.pumpOn ? "dot-green" : "dot-red");
  $("btnPumpOn").disabled = state.pumpOn;
  $("btnPumpOff").disabled = !state.pumpOn;
  const manualRuntime = $("manualRuntime");
   if (manualRuntime) {
      if (state.pumpOn && state.pumpStartTs) {
         manualRuntime.classList.remove("hidden");
         manualRuntime.textContent =
            "جاري الري منذ " + fmtElapsed(Date.now() - state.pumpStartTs);
      } else {
         manualRuntime.classList.add("hidden");
        }
   }

  // الري المؤقت
  if (!state.timedEndsAt) {
    $("timedRun").classList.add("hidden");
    $("btnTimedStart").classList.remove("hidden");
    $("btnTimedStop").classList.add("hidden");
  }

  // الري الذكي
  const chip = $("smartChip");
  chip.textContent = state.smartActive ? "مفعل" : "متوقف";
  chip.className = "pill " + (state.smartActive ? "pill-ok" : "pill-off");
  const tgl = $("btnSmartToggle");
  tgl.textContent = state.smartActive ? "إيقاف الري الذكي" : "تفعيل الري الذكي";
  tgl.className = "btn btn-block " + (state.smartActive ? "btn-danger" : "btn-primary");
  $("smartMoisture").textContent = Math.round(state.moisture);
  $("smartFill").style.width = state.moisture + "%";

  const msg = $("smartMsg");
  const rainHolds = state.rain || (state.rainForecast !== null && state.rainForecast >= 55);
  if (!state.smartActive) {
    msg.textContent = "النظام التلقائي متوقف حالياً — يمكنك التحكم بالري يدوياً.";
    msg.className = "smart-msg warn";
  } else if (rainHolds) {
    msg.textContent = "مطر متوقع/مرصود — تم تأجيل الري تلقائياً لتوفير المياه";
    msg.className = "smart-msg rain";
  } else if (state.moisture < state.thresholds.on) {
    msg.textContent = "التربة جافة — " + (state.pumpOn ? "جاري الري الآن" : "سيبدأ الري تلقائياً");
    msg.className = "smart-msg warn";
  } else if (state.moisture >= state.thresholds.off) {
    msg.textContent = "وصلت الرطوبة إلى المستوى المناسب — توقف الري";
    msg.className = "smart-msg ok";
  } else {
    msg.textContent = "الرطوبة مناسبة — لا توجد حاجة للري في الوقت الحالي";
    msg.className = "smart-msg ok";
  }
  $("logicOn").textContent = state.thresholds.on + "%";
  $("logicOff").textContent = state.thresholds.off + "%";
  $("waterSaved").textContent = computeWaterSaved().toFixed(1);

  // مصدر البيانات + هوية المزرعة
  $("soilSrc").textContent = HydrixBLE.isConnected() ? "مباشر من الحساس" : "وضع تجريبي";
  $("soilSrc").classList.toggle("on", HydrixBLE.isConnected());
  const cropTag = $("soilCrop");
  cropTag.hidden = !state.crop;
  cropTag.textContent = state.crop;

  renderIndicators();
}

/* ---------------- مؤشرات محسوبة من البيانات الفعلية ---------------- */
function computeWaterSaved() {
  // تقدير: كل دورة ري ذكي توفر لتراً ونصفاً مقارنة بالري اليدوي الغزير
  const smartCycles = state.log.filter((l) => l.e === "start" && l.m === "smart").length;
  return smartCycles * 1.5;
}

function renderIndicators() {
  const recent = state.samples.slice(-36);
  let health = "—";
  if (recent.length > 3) {
    const a = state.thresholds.on, b = state.thresholds.off;
    const inBand = recent.filter((s) => s.m >= a - 5 && s.m <= b + 5).length / recent.length;
    health = Math.round(40 + inBand * 55);
  }
  $("indHealth").textContent = health;

  let stab = "—";
  if (recent.length > 3) {
    const mean = recent.reduce((s, p) => s + p.m, 0) / recent.length;
    const sd = Math.sqrt(recent.reduce((s, p) => s + (p.m - mean) ** 2, 0) / recent.length);
    stab = sd < 4 ? "مستقر" : sd < 9 ? "متوسط" : "متذبذب";
  }
  $("indStab").textContent = stab;

  const days = new Set(state.log.filter((l) => l.e === "start").map((l) => new Date(l.t).toDateString()));
  let cnt = 0;
  for (let i = 0; i < 7; i++) {
    if (days.has(new Date(Date.now() - i * 864e5).toDateString())) cnt++;
  }
  $("indReg").textContent = cnt + "/7";
}

/* ---------------- سجل النشاط ---------------- */
function fmtClock(ts) {
  return new Date(ts).toLocaleString("ar-EG", { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" });
}

function renderHistory() {
  // الإحصائيات
  const today = new Date().toDateString();
  const startsToday = state.log.filter((l) => l.e === "start" && new Date(l.t).toDateString() === today);
  const minutesToday = state.log
    .filter((l) => l.e === "stop" && l.d && new Date(l.t).toDateString() === today)
    .reduce((s, l) => s + l.d, 0);
  $("statCount").textContent = startsToday.length;
  $("statMinutes").textContent = Math.round(minutesToday / 60000);
  $("statTotal").textContent = state.log.filter((l) => l.e === "start").length;

  // قائمة العمليات
  const list = $("logList");
  list.innerHTML = "";
  const icons = { manual: "i-sliders", timed: "i-timer", smart: "i-robot", device: "i-bt" };
  state.log.slice(0, 30).forEach((l) => {
    const row = document.createElement("div");
    row.className = "log-row";
    const isStart = l.e === "start";
    const dur = l.d ? ` · المدة ${Math.max(1, Math.round(l.d / 60000))} دقيقة` : "";
    const icon = isStart ? (icons[l.m] || "i-shower") : "i-stop";
    row.innerHTML = `
      <span class="log-icon ${isStart ? "" : "stop"}" aria-hidden="true"><svg class="ic"><use href="#${icon}"/></svg></span>
      <div class="log-body">
        <b>${isStart ? `بدأ الري — ${MODE_NAMES[l.m] || l.m}` : `توقف الري — ${MODE_NAMES[l.m] || l.m}`}</b>
        <span>${fmtClock(l.t)}${dur}</span>
      </div>`;
    list.appendChild(row);
  });
  $("logEmpty").hidden = state.log.length > 0;

  drawMoistChart();
}

function drawMoistChart() {
  const cv = $("moistChart");
  const dpr = window.devicePixelRatio || 1;
  const W = cv.clientWidth || 320;
  const H = 150;
  cv.width = W * dpr;
  cv.height = H * dpr;
  const ctx = cv.getContext("2d");
  ctx.scale(dpr, dpr);
  ctx.clearRect(0, 0, W, H);

  const padR = 26, padY = 10;
  const plotW = W - padR - 2;
  const y = (m) => padY + (1 - m / 100) * (H - padY * 2);
  const data = state.samples;
  const t0 = data.length ? data[0].t : 0;
  const t1 = data.length ? data[data.length - 1].t : 1;

  // شبكة أفقية + تسميات النسب
  ctx.font = "9px sans-serif";
  ctx.textAlign = "left";
  for (const m of [0, 50, 100]) {
    ctx.strokeStyle = "#e7efe6";
    ctx.beginPath();
    ctx.moveTo(0, y(m));
    ctx.lineTo(plotW, y(m));
    ctx.stroke();
    ctx.fillStyle = "#7d8f83";
    ctx.fillText(m + "%", plotW + 5, y(m) + 3);
  }

  // خطا الحد الأدنى (بدء الري) والحد الأقصى (توقف الري)
  ctx.setLineDash([5, 4]);
  ctx.lineWidth = 1.4;
  ctx.strokeStyle = "#d97706";
  ctx.beginPath(); ctx.moveTo(0, y(state.thresholds.on)); ctx.lineTo(plotW, y(state.thresholds.on)); ctx.stroke();
  ctx.strokeStyle = "#38bdf8";
  ctx.beginPath(); ctx.moveTo(0, y(state.thresholds.off)); ctx.lineTo(plotW, y(state.thresholds.off)); ctx.stroke();
  ctx.setLineDash([]);

  if (data.length < 2) return;
  const x = (t) => (t1 === t0 ? 0 : ((t - t0) / (t1 - t0)) * plotW);

  // تظليل تحت الخط
  const grad = ctx.createLinearGradient(0, padY, 0, H - padY);
  grad.addColorStop(0, "rgba(34,197,94,0.28)");
  grad.addColorStop(1, "rgba(34,197,94,0.02)");
  ctx.fillStyle = grad;
  ctx.beginPath();
  ctx.moveTo(x(data[0].t), y(data[0].m));
  data.forEach((p) => ctx.lineTo(x(p.t), y(p.m)));
  ctx.lineTo(x(t1), H - padY);
  ctx.lineTo(x(t0), H - padY);
  ctx.closePath();
  ctx.fill();

  // خط الرطوبة
  ctx.strokeStyle = "#22c55e";
  ctx.lineWidth = 2.2;
  ctx.lineJoin = "round";
  ctx.beginPath();
  data.forEach((p, i) => (i ? ctx.lineTo(x(p.t), y(p.m)) : ctx.moveTo(x(p.t), y(p.m))));
  ctx.stroke();

  // نقطة آخر قراءة
  const last = data[data.length - 1];
  ctx.fillStyle = "#15803d";
  ctx.beginPath();
  ctx.arc(x(last.t), y(last.m), 4, 0, 7);
  ctx.fill();
  ctx.fillStyle = "#fff";
  ctx.beginPath();
  ctx.arc(x(last.t), y(last.m), 1.8, 0, 7);
  ctx.fill();
}

$("btnExportCsv").addEventListener("click", exportCsv);
$("btnExportCsv2").addEventListener("click", exportCsv);

function exportCsv() {
  const rows = [["الوقت", "الحدث", "الوضع", "المدة (دقيقة)"]];
  state.log.forEach((l) => {
    rows.push([
      new Date(l.t).toLocaleString("ar-EG"),
      l.e === "start" ? "بدأ الري" : "توقف الري",
      MODE_NAMES[l.m] || l.m,
      l.d ? Math.max(1, Math.round(l.d / 60000)) : "",
    ]);
  });
  const csv = "\ufeff" + rows.map((r) => r.join(",")).join("\n");
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
  a.download = "hydrix-log.csv";
  a.click();
  URL.revokeObjectURL(a.href);
  toast("تم تصدير السجل");
}

$("btnClearLog").addEventListener("click", () => {
  if (!confirm("متأكد من مسح السجل بالكامل؟")) return;
  state.log = [];
  state.samples = [];
  localStorage.removeItem("hydrix_log");
  localStorage.removeItem("hydrix_samples");
  renderHistory();
  toast("تم مسح السجل");
});

/* ---------------- التنبيهات ---------------- */
function updateNotifyChip() {
  document.querySelectorAll(".notifyToggle .notify-text").forEach((el) => {
    el.textContent = state.notifyOn ? "التنبيهات: مفعلة" : "التنبيهات: غير مفعلة";
  });
}

document.querySelectorAll(".notifyToggle").forEach((btn) =>
  btn.addEventListener("click", async () => {
    if (state.notifyOn) {
      state.notifyOn = false;
      localStorage.setItem("hydrix_notify", "0");
      updateNotifyChip();
      toast("تم إيقاف التنبيهات");
      return;
    }
    if (!("Notification" in window)) {
      toast("التنبيهات غير مدعومة في هذا المتصفح");
      return;
    }
    let perm = Notification.permission;
    if (perm === "default") perm = await Notification.requestPermission();
    if (perm === "granted") {
      state.notifyOn = true;
      localStorage.setItem("hydrix_notify", "1");
      updateNotifyChip();
      notify("تم تفعيل التنبيهات — هيوصلك إشعار لما النظام يري");
      toast("تم تفعيل التنبيهات");
    } else {
      toast("اتسمح بالإشعارات من إعدادات المتصفح الأول");
    }
  })
);

/* ---------------- حدود الري الذكي ---------------- */
function syncThresholdUI() {
  $("thOn").value = state.thresholds.on;
  $("thOff").value = state.thresholds.off;
  $("thOnVal").textContent = state.thresholds.on + "%";
  $("thOffVal").textContent = state.thresholds.off + "%";
}

let thSendTimer = null;
function onThresholdChange() {
  let on = Number($("thOn").value);
  let off = Number($("thOff").value);
  if (on > off - 10) {
    on = off - 10;
    $("thOn").value = on;
  }
  if (off < on + 10) {
    off = on + 10;
    $("thOff").value = off;
  }
  state.thresholds = { on, off };
  localStorage.setItem("hydrix_th", JSON.stringify(state.thresholds));
  syncThresholdUI();
  render();
  clearTimeout(thSendTimer);
  thSendTimer = setTimeout(() => {
    if (sendBLE(`TH:${on},${off}`)) toast(`تم إرسال الحدود للجهاز: بدء ${on}% · توقف ${off}%`);
  }, 500);
}
$("thOn").addEventListener("input", onThresholdChange);
$("thOff").addEventListener("input", onThresholdChange);

/* ---------------- الإعدادات وهوية المزرعة ---------------- */
$("btnSettings").addEventListener("click", () => { location.hash = "settings"; });

function syncSettingsUI() {
  $("setFarmName").value = state.farmName;
  document.querySelectorAll(".crop-chip").forEach((c) =>
    c.classList.toggle("selected", c.dataset.crop === state.crop)
  );
}

$("setFarmName").addEventListener("input", (e) => {
  state.farmName = e.target.value.trim();
  localStorage.setItem("hydrix_farm", state.farmName);
  applyIdentity();
});

document.querySelectorAll(".crop-chip").forEach((chip) =>
  chip.addEventListener("click", () => {
    state.crop = chip.dataset.crop;
    localStorage.setItem("hydrix_crop", state.crop);
    syncSettingsUI();
    render();
    toast(state.crop ? `المحصول: ${state.crop} — سيُستخدم في تشخيص الـ AI` : "تم إلغاء تحديد المحصول");
  })
);

function applyIdentity() {
  $("dashSub").textContent = state.farmName
    ? `${state.farmName} — إدارة التربة والري`
    : "مزرعة Hydrix الذكية — إدارة التربة والري";
  document.title = (state.farmName ? state.farmName + " · " : "") + "Hydrix — المزرعة الذكية";
}

$("btnResetAll").addEventListener("click", () => {
  if (!confirm("هيتم مسح كل السجلات والإعدادات المحفوظة على هذا الجهاز. متأكد؟")) return;
  Object.keys(localStorage)
    .filter((k) => k.startsWith("hydrix_"))
    .forEach((k) => localStorage.removeItem(k));
  location.hash = "";
  location.reload();
});

/* ---------------- التهيئة ---------------- */
// بيانات ترحيبية للسجل والرسم البياني في أول تشغيل (وضع تجريبي)
if (!localStorage.getItem("hydrix_seeded")) {
  const now = Date.now();
  const samples = [];
  for (let i = 40; i >= 0; i--) {
    const t = now - i * 1500000; // كل 25 دقيقة
    const m = 52 + Math.sin((40 - i) / 6) * 14 + Math.cos((40 - i) / 2.7) * 4;
    samples.push({ t, m: Math.round(clamp(m, 28, 78)) });
  }
  state.samples = samples;
  state.log = [
    { t: now - 3600000, e: "stop", m: "smart", d: 1260000 },
    { t: now - 4860000, e: "start", m: "smart" },
    { t: now - 9000000, e: "stop", m: "manual", d: 480000 },
    { t: now - 9480000, e: "start", m: "manual" },
    { t: now - 90000000, e: "stop", m: "timed", d: 600000 },
    { t: now - 90600000, e: "start", m: "timed" },
  ];
  localStorage.setItem("hydrix_samples", JSON.stringify(state.samples));
  localStorage.setItem("hydrix_log", JSON.stringify(state.log));
  localStorage.setItem("hydrix_seeded", "1");
}

state.notifyOn = localStorage.getItem("hydrix_notify") === "1";
applyIdentity();
syncThresholdUI();
updateNotifyChip();
navigate();
render();
if ("serviceWorker" in navigator && (location.protocol === "https:" || location.hostname === "localhost")) {
  navigator.serviceWorker.register("sw.js").catch(() => {});
}
