/* ============================================================
   Hydrix — وحدة الاتصال بالبلوتوث (BLE)
   تتصل بجهاز ESP32 الذي يعمل كـ BLE UART:
     Service : 0000ffe0-…
     RX      : 0000ffe1-…  (التطبيق → ESP32) كتابة الأوامر
     TX      : 0000ffe2-…  (ESP32 → التطبيق) قراءات JSON
   ملاحظة: Web Bluetooth يعمل على Chrome/Edge (أندرويد وسطح المكتب)
   ويتطلب سياقاً آمناً (HTTPS أو localhost).
   ============================================================ */

const HydrixBLE = (() => {
  const SERVICE_UUID = "0000ffe0-0000-1000-8000-00805f9b34fb";
  const RX_UUID = "0000ffe1-0000-1000-8000-00805f9b34fb"; // write
  const TX_UUID = "0000ffe2-0000-1000-8000-00805f9b34fb"; // notify

  let device = null;
  let rxChar = null;
  let onMessage = null;   // (obj|string) => void
  let onStateChange = null; // (connected:boolean) => void

  function supported() {
    return typeof navigator !== "undefined" && !!navigator.bluetooth;
  }

  async function connect() {
    if (!supported()) throw new Error("البلوتوث غير مدعوم في هذا المتصفح — استخدم Chrome على أندرويد");
    if (device && device.gatt && device.gatt.connected) return;

    device = await navigator.bluetooth.requestDevice({
      acceptAllDevices: true,
      optionalServices: [
        "0000ffe0-0000-1000-8000-00805f9b34fb"
      ]
    });

    device.addEventListener("gattserverdisconnected", () => {
      rxChar = null;
      if (onStateChange) onStateChange(false);
    });

    const server = await device.gatt.connect();
    const service = await server.getPrimaryService(SERVICE_UUID);
    rxChar = await service.getCharacteristic(RX_UUID);
    const txChar = await service.getCharacteristic(TX_UUID);

    await txChar.startNotifications();
    txChar.addEventListener("characteristicvaluechanged", (e) => {
      const text = new TextDecoder().decode(e.target.value);
      if (!onMessage) return;
      try {
        onMessage(JSON.parse(text));
      } catch {
        onMessage(text.trim());
      }
    });

    if (onStateChange) onStateChange(true);
    return device;
  }

  function disconnect() {
    if (device && device.gatt && device.gatt.connected) device.gatt.disconnect();
    rxChar = null;
  }

  function send(cmd) {
    if (!rxChar) return false;
    const bytes = new TextEncoder().encode(cmd + "\n");
    rxChar.writeValue(bytes).catch((err) => console.warn("BLE write failed:", err));
    return true;
  }

  function isConnected() {
    return !!(device && device.gatt && device.gatt.connected && rxChar);
  }

  return {
    supported,
    connect,
    disconnect,
    send,
    isConnected,
    set onMessage(fn) { onMessage = fn; },
    set onStateChange(fn) { onStateChange = fn; },
  };
})();
