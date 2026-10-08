# Obur Delik 🕳️

Şehri yut, büyü, rakip delikleri yut! Mobil için tasarlanmış, tarayıcıda çalışan 3D bir "hole" oyunu.

**Oyna:** `index.html` dosyasını herhangi bir statik sunucuda aç (ör. GitHub Pages). Telefonda “Ana ekrana ekle” ile tam ekran uygulama gibi çalışır, çevrimdışı da açılır.

## Modlar
- **Arena** – 8 delik, 2 dakika. Küçükleri yut, büyüklerden kaç. En yüksek puan kazanır.
- **Solo** – 2 dakikada şehrin yüzde kaçını yutabilirsin? (1–3 yıldız)

## Kontroller
- **Dokunmatik:** ekranın herhangi bir yerine dokun ve sürükle (yüzen joystick).
- **Klavye:** WASD / ok tuşları.

## Teknik
- Saf HTML + CSS + JavaScript (ES modülleri), derleme adımı yok.
- WebGL render için [three.js](https://threejs.org) r170 (`lib/` içinde, CDN gerekmez).
- 65+ prosedürel low-poly asset (insanlar, araçlar, ağaçlar, binalar, sokak eşyaları…), her tür tek bir `InstancedMesh` çağrısında çizilir.
- Kare başına frustum culling + instance sıkıştırma: yalnızca ekrandaki nesneler GPU'ya gönderilir.
- Deliğin zemini “kesmesi” stencil buffer ile yapılır; FPS düşerse çözünürlük otomatik azaltılır.
- Çift dokunma / pinch zoom, uzun basma menüsü, çekerek yenileme engellidir; PWA manifesti ve service worker ile çevrimdışı çalışır.
- Ses efektleri WebAudio ile sentezlenir, Android'de titreşim geri bildirimi vardır.

`?fps` parametresi FPS sayacını gösterir.
