/* ============================================================
   Hydrix Smart Farm — ESP32 (BLE + حساسات + مضخة)
   ------------------------------------------------------------
   يتصل بتطبيق Hydrix عبر البلوتوث (BLE UART):
     Service : 0000ffe0-0000-1000-8000-00805f9b34fb
     RX (ffe1): يستقبل أوامر من التطبيق
     TX (ffe2): يرسل قراءات JSON للتطبيق كل ثانيتين

   الأوامر المقبولة من التطبيق:
     ON          تشغيل المضخة (يدوي)
     OFF         إيقاف المضخة
     T5/T10/T15/T30   ري مؤقت بالدقائق
     SMART_ON    تفعيل الري الذكي
     SMART_OFF   إيقاف الري الذكي
     TH:40,60    ضبط حدود الري الذكي (بدء 40% / توقف 60%)
     PING        اختبار الاتصال (يرد PONG)

   الحساسات:
     Soil Moisture  → GPIO 34 (ADC)
     Rain Sensor    → GPIO 35 (ADC)
     DHT22          → GPIO 4
     Relay (المضخة) → GPIO 26 (نشط بمستوى منخفض LOW = تشغيل)

   المكتبات المطلوبة: "DHT sensor library" (بمرافقتها Adafruit Unified Sensor)
   مكتبة BLE مدمجة مع لوحات ESP32 في Arduino IDE.
   ============================================================ */

#include <BLEDevice.h>
#include <BLEServer.h>
#include <BLEUtils.h>
#include <BLE2902.h>
#include <DHT.h>

// ---------- الإعدادات ----------
#define SERVICE_UUID "0000ffe0-0000-1000-8000-00805f9b34fb"
#define RX_CHAR_UUID "0000ffe1-0000-1000-8000-00805f9b34fb"
#define TX_CHAR_UUID "0000ffe2-0000-1000-8000-00805f9b34fb"

#define PIN_SOIL  34
#define PIN_RAIN  35
#define PIN_DHT   4
#define PIN_RELAY 26

// معايرة حساس الرطوبة: اقرأ القيم الخام جافة/مبللة وعدّلها
int SOIL_DRY = 3200;   // القراءة الخام في هواء جاف
int SOIL_WET = 1300;   // القراءة الخام داخل الماء

#define RAIN_WET_RAW 2000   // أقل من كده = مطر
#define RELAY_ON  LOW       // معظم وحدات الريلي نشطة بـ LOW
#define RELAY_OFF HIGH

int smartStart = 40;        // يبدأ الري تحت هذه النسبة (تتغير من التطبيق)
int smartStop = 60;         // يتوقف عند هذه النسبة (تتغير من التطبيق)

// ---------- المتغيرات ----------
DHT dht(PIN_DHT, DHT22);
BLECharacteristic *txChar;

bool pumpOn = false;
bool smartActive = true;
unsigned long timedEndsAt = 0;     // 0 = لا يوجد مؤقت
unsigned long lastNotify = 0;
unsigned long pumpOnSince = 0;     // لأمان الري اليدوي
bool deviceConnected = false;

#define MANUAL_MAX_RUN 1200000UL   // أقصى تشغيل يدوي متصل: 20 دقيقة ثم إيقاف أمان

float tempC = 0, humAir = 0;
int moisturePct = 0;
bool raining = false;

// ---------- أدوات ----------
int readMoisturePct() {
  int raw = analogRead(PIN_SOIL);
  int pct = map(raw, SOIL_DRY, SOIL_WET, 0, 100);
  return constrain(pct, 0, 100);
}

bool readRain() {
  return analogRead(PIN_RAIN) < RAIN_WET_RAW;
}

void setPump(bool on) {
  pumpOn = on;
  digitalWrite(PIN_RELAY, on ? RELAY_ON : RELAY_OFF);
}

void notifyState() {
  if (!deviceConnected) return;
  String json = "{\"moist\":" + String(moisturePct) +
                ",\"temp\":" + String(tempC, 1) +
                ",\"hum\":" + String(humAir, 0) +
                ",\"rain\":" + String(raining ? 1 : 0) +
                ",\"pump\":" + String(pumpOn ? 1 : 0) +
                ",\"smart\":" + String(smartActive ? 1 : 0) +
                ",\"th\":[" + String(smartStart) + "," + String(smartStop) + "]}";
  txChar->setValue((uint8_t *)json.c_str(), json.length());
  txChar->notify();
}

// استقبال حدود الري الجديدة من التطبيق: "TH:40,60"
void applyThresholds(const String &cmd) {
  int comma = cmd.indexOf(',');
  if (comma == -1) return;
  int on = cmd.substring(3, comma).toInt();
  int off = cmd.substring(comma + 1).toInt();
  if (on >= 10 && off <= 95 && on < off) {
    smartStart = on;
    smartStop = off;
    Serial.printf("حدود جديدة: بدء %d%% توقف %d%%\n", smartStart, smartStop);
  }
}

// ---------- استقبال أوامر التطبيق ----------
class RxCallbacks : public BLECharacteristicCallbacks {
  void onWrite(BLECharacteristic *ch) override {
    String cmd = String(ch->getValue().c_str());
    cmd.trim();
    cmd.toUpperCase();
    Serial.println("CMD: " + cmd);

    if (cmd == "ON") {
      timedEndsAt = 0;
      setPump(true);
    } else if (cmd == "OFF") {
      timedEndsAt = 0;
      setPump(false);
    } else if (cmd.startsWith("T")) {
      int minutes = cmd.substring(1).toInt();   // T5 / T10 / T15 / T30
      if (minutes > 0 && minutes <= 120) {
        timedEndsAt = millis() + (unsigned long)minutes * 60000UL;
        setPump(true);
      }
    } else if (cmd == "SMART_ON") {
      smartActive = true;
    } else if (cmd == "SMART_OFF") {
      smartActive = false;
      setPump(false);
    } else if (cmd.startsWith("TH:")) {
      applyThresholds(cmd);
    } else if (cmd == "PING") {
      String pong = "PONG";
      txChar->setValue((uint8_t *)pong.c_str(), pong.length());
      txChar->notify();
    }
  }
};

class ServerCallbacks : public BLEServerCallbacks {
  void onConnect(BLEServer *) override {
    deviceConnected = true;
    Serial.println("BLE: متصل");
  }
  void onDisconnect(BLEServer *) override {
    deviceConnected = false;
    Serial.println("BLE: انقطع الاتصال");
    BLEDevice::startAdvertising();   // اسمح بإعادة الاتصال
  }
};

// ---------- الإعداد ----------
void setup() {
  Serial.begin(115200);
  pinMode(PIN_RELAY, OUTPUT);
  digitalWrite(PIN_RELAY, RELAY_OFF);
  dht.begin();

  BLEDevice::init("Hydrix Farm");
  BLEServer *server = BLEDevice::createServer();
  server->setCallbacks(new ServerCallbacks());

  BLEService *service = server->createService(SERVICE_UUID);

  BLECharacteristic *rx = service->createCharacteristic(
      RX_CHAR_UUID, BLECharacteristic::PROPERTY_WRITE);
  rx->setCallbacks(new RxCallbacks());

  txChar = service->createCharacteristic(
      TX_CHAR_UUID, BLECharacteristic::PROPERTY_NOTIFY);
  txChar->addDescriptor(new BLE2902());

  service->start();

  BLEAdvertising *adv = BLEDevice::getAdvertising();
  adv->addServiceUUID(SERVICE_UUID);
  adv->setScanResponse(true);
  BLEDevice::startAdvertising();

  Serial.println("Hydrix جاهز — اسم الجهاز: Hydrix Farm");
}

// ---------- الحلقة الرئيسية ----------
void loop() {
  unsigned long now = millis();

  if (now - lastNotify >= 2000) {
    lastNotify = now;
    moisturePct = readMoisturePct();
    raining = readRain();
    float t = dht.readTemperature();
    float h = dht.readHumidity();
    if (!isnan(t)) tempC = t;
    if (!isnan(h)) humAir = h;

    // انتهاء الري المؤقت
    if (timedEndsAt != 0 && now >= timedEndsAt) {
      timedEndsAt = 0;
      setPump(false);
      Serial.println("انتهى الري المؤقت");
    }

    // أمان الري اليدوي: لو الموبايل انفصل والمضخة شغالة، توقف لوحدها بعد 20 دقيقة
    if (pumpOn && pumpOnSince == 0) pumpOnSince = now;
    if (!pumpOn) pumpOnSince = 0;
    if (pumpOn && timedEndsAt == 0 && !smartActive &&
        pumpOnSince != 0 && now - pumpOnSince >= MANUAL_MAX_RUN) {
      setPump(false);
      Serial.println("إيقاف أمان: انتهى أقصى زمن للتشغيل اليدوي");
    }

    // منطق الري الذكي على الجهاز نفسه (يعمل حتى لو التطبيق مقفل)
    if (smartActive && timedEndsAt == 0) {
      if (!pumpOn && moisturePct < smartStart && !raining) setPump(true);
      else if (pumpOn && (moisturePct >= smartStop || raining)) setPump(false);
    }

    notifyState();

    Serial.printf("رطوبة: %d%% | حرارة: %.1f | رطوبة جو: %.0f | مطر: %d | مضخة: %d | ذكي: %d\n",
                  moisturePct, tempC, humAir, raining, pumpOn, smartActive);
  }
}
