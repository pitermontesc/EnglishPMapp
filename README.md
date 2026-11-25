# Daily English

App de práctica diaria de inglés: lectura en voz alta con evaluación de pronunciación,
vocabulario con repaso espaciado, ejercicios y feedback al hablar.

Un solo código web que funciona en:

| Plataforma | Cómo se ejecuta |
|---|---|
| **Web** (cualquier navegador) | `npm run build` → sube `dist/` a cualquier hosting estático. Se puede instalar como app (PWA). |
| **Mac** (Apple Silicon) | El proyecto iOS corre en Mac como app nativa ("Designed for iPad"). |
| **iPhone / iPad** | Proyecto Xcode en `ios/` (Capacitor). |
| **Android** | Proyecto Android Studio en `android/` (Capacitor). |

## Requisitos

- Node.js 20 o superior
- **Mac / iOS:** Xcode (App Store). La primera vez: `sudo xcode-select -s /Applications/Xcode.app`.
- **Android:** Android Studio (incluye el SDK y Java).

## Empezar

```bash
npm install
npm run dev        # versión web en http://localhost:5173
```

### Web

```bash
npm run build      # genera dist/
npm run preview    # prueba la versión compilada
```

Sube `dist/` a Netlify, Vercel, GitHub Pages, Cloudflare Pages, etc. Necesita HTTPS para el micrófono.
Para instalarla: en Chrome/Edge, botón "Instalar" en la barra de direcciones; en Safari para Mac,
Archivo → "Añadir al Dock"; en iPhone, Compartir → "Añadir a pantalla de inicio".

### Mac

```bash
npm run mac        # compila, sincroniza y abre Xcode
```

En Xcode elige el destino **My Mac (Designed for iPad)** y pulsa ▶︎. En Signing & Capabilities
selecciona tu equipo (Team); con una cuenta de Apple gratuita basta para tu propio Mac.

### iPhone / iPad

```bash
npm run ios
```

Conecta el iPhone, elígelo como destino en Xcode y pulsa ▶︎.

### Android

```bash
npm run android
```

En Android Studio espera a que termine Gradle y pulsa ▶︎ con un teléfono conectado (depuración USB
activada) o un emulador.

### Después de cambiar el código

```bash
npm run sync       # compila la web y copia los cambios a ios/ y android/
```

## Claude (historias, coaching y feedback)

La app usa tu propia clave de la API de Anthropic. Créala en
[console.anthropic.com](https://console.anthropic.com/settings/keys) y pégala en **Settings** dentro de la app.
La clave se guarda solo en el dispositivo y las llamadas van directo a la API de Anthropic,
sin servidor propio. Cada uso se cobra a tu cuenta de la API.

- Modelo por defecto: Claude Opus 5.5 (se puede cambiar a Sonnet 5.5 o Haiku 5.5 en Settings).
- Con la opción activada, al abrir la app se crea la historia del día si todavía no existe.
- Sin clave, la app funciona con la historia inicial incluida y con las historias ya guardadas.

No publiques la versión web con una clave escrita en el código: cada persona pone la suya en Settings.

## Cómo funciona cada pieza

| Función | Web | iOS / Mac / Android |
|---|---|---|
| Datos (lecciones, sesiones, palabras, vocabulario) | `localStorage` | Capacitor Preferences |
| Micrófono (voz → texto) | Web Speech API (Chrome, Edge, Safari) | Reconocimiento del sistema: `@capgo/capacitor-speech-recognition` |
| Voz (texto → voz) | `speechSynthesis` | Voces del sistema: `@capacitor-community/text-to-speech` |
| Claude | `@anthropic-ai/sdk` | igual |
| Copia de seguridad | descarga de archivo | menú Compartir |

Los datos viven en cada dispositivo. Para pasar el progreso a otro: Settings → **Export backup**,
y en el otro dispositivo **Import backup**.

## Estructura

```
index.html                 interfaz
src/main.js                lógica de la app (lecciones, lectura, repaso, progreso, ajustes)
src/styles.css             estilos (claro/oscuro, márgenes seguros para notch)
src/platform/              adaptadores: storage, speech, tts, ai, files
src/lessons/starter.json   historia incluida para usar la app sin clave
public/                    manifest PWA, service worker, iconos web
assets/                    imágenes fuente de iconos y splash (npm run icons)
scripts/make-icons.mjs     dibuja los iconos
ios/  android/             proyectos nativos generados por Capacitor
artifact/index.html        versión original que corre dentro de Claude (artifact)
```

## Iconos

```bash
npm run icons      # regenera iconos y splash para web, iOS y Android desde scripts/make-icons.mjs
```

## Identificador de la app

`com.dailyenglish.app` (en `capacitor.config.json`). Cámbialo por uno tuyo antes de publicar en
App Store o Google Play.

## Versión dentro de Claude

`artifact/index.html` es la versión original publicada como artifact de Claude
(https://claude.ai/artifact/K6ScLg7cR9EAv2TUAPdawS). Usa las capacidades del runtime de Claude
(`window.claude`) y no comparte datos con las apps.

## Límite conocido

La pronunciación se evalúa por transcripción: se marca la palabra que el reconocimiento de voz
no entendió. No hay análisis fonético ni de entonación.
