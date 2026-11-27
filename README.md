# Daily English

App de práctica diaria de inglés: lectura en voz alta con evaluación de pronunciación,
vocabulario con repaso espaciado, ejercicios y feedback al hablar.

Por ahora funciona en dos sitios:

| Plataforma | Cómo se ejecuta |
|---|---|
| **Chrome** (web) | https://pitermontesc.github.io/EnglishPMapp/ · se puede instalar como app desde Chrome. |
| **Mac** (Apple Silicon) | App nativa: el proyecto de Xcode en `ios/` corre en Mac como "Designed for iPad". |

## Requisitos

- Node.js 20 o superior
- **Mac:** Xcode (App Store). La primera vez: `sudo xcode-select -s /Applications/Xcode.app`.

## Empezar

```bash
npm install
npm run dev        # versión web en http://localhost:5173 (ábrela en Chrome)
```

### Chrome (web)

**Publicada en GitHub Pages:** https://pitermontesc.github.io/EnglishPMapp/

Para publicar una nueva versión:

```bash
npm run deploy:web   # compila y reemplaza la rama gh-pages; el sitio se actualiza en 1 o 2 minutos
```

Para instalarla como app en el Mac: abre el enlace en Chrome y pulsa el botón "Instalar" en la barra de direcciones.
El micrófono de la versión web usa el reconocimiento de voz de Chrome, que necesita conexión a internet.

### Mac

**Instalar o actualizar la app en tu Mac:**

```bash
npm run mac:install
```

Compila la app, la instala en **Aplicaciones** como `Daily English.app` (reemplaza la versión anterior)
y la abre. Si macOS pide la contraseña del llavero para `codesign`, escribe la contraseña de tu Mac
y pulsa **Always Allow**.

Para probar cambios con logs: `npm run mac` abre Xcode; elige **My Mac (Designed for iPad)** y pulsa ▶︎.

La firma usa tu *Personal Team* (seleccionado en Xcode → target App → Signing & Capabilities).
Con una cuenta gratuita, Apple caduca la firma a los 7 días: si la app deja de abrir, vuelve a
ejecutar `npm run mac:install`.

### Después de cambiar el código

```bash
npm run sync         # compila la web y copia los cambios a la app de Mac
npm run deploy:web   # publica los cambios en la web
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

| Función | Chrome | Mac |
|---|---|---|
| Datos (lecciones, sesiones, palabras, vocabulario) | `localStorage` | Capacitor Preferences |
| Micrófono (voz → texto) | Web Speech API de Chrome | Reconocimiento de Apple: `@capgo/capacitor-speech-recognition` |
| Voz (texto → voz) | `speechSynthesis` | Voces del sistema: `@capacitor-community/text-to-speech` |
| Claude | `@anthropic-ai/sdk` | igual |
| Copia de seguridad | descarga de archivo | menú Compartir |

Los datos viven en cada dispositivo. Para pasar el progreso a otro: Settings → **Export backup**,
y en el otro dispositivo **Import backup**.

## Pruebas

```bash
npm test           # pruebas de unidad (Vitest): alineación de palabras, cuándo termina una lectura,
                   # detección de voz, puntajes y repaso, micrófono de Mac y de Chrome, datos, Claude y voz
npm run test:e2e   # simulacro de un día completo en Chrome, con conversación incluida
```

El simulacro abre la app compilada en Chrome sin ventana, con un micrófono falso que "dice" frases
preparadas, una voz falsa y un Claude falso que responde en streaming como la API. Lee la historia con
un error, practica la palabra, responde los ejercicios, mantiene la conversación de *Speak freely* con
feedback, revisa el progreso y reabre la app. No usa la red ni el micrófono real. Necesita Google Chrome
(o la ruta en `CHROME_PATH`).

## Estructura

```
index.html                 interfaz
src/main.js                lógica de la app (lecciones, lectura, repaso, progreso, ajustes)
src/core/                  lógica pura con pruebas: texto y puntajes (text.js), fin de cada lectura (take.js)
tests/unit/                pruebas de unidad (Vitest)
tests/e2e/session.mjs      simulacro de un día completo con conversación (Chrome)
src/styles.css             estilos (claro/oscuro, márgenes seguros para notch)
src/platform/              adaptadores: storage, speech, tts, ai, files
src/lessons/starter.json   historia incluida para usar la app sin clave
public/                    manifest PWA, service worker, iconos web
assets/                    imágenes fuente de iconos y splash (npm run icons)
scripts/make-icons.mjs     dibuja los iconos
ios/                       proyecto de Xcode (app de Mac) generado por Capacitor
artifact/index.html        versión original que corre dentro de Claude (artifact)
```

## Iconos

```bash
npm run icons      # regenera iconos y splash para web y Mac desde scripts/make-icons.mjs
```

## Identificador de la app

`com.pitermontes.dailyenglish` (en `capacitor.config.json` y en el proyecto de Xcode). Para publicar en la
App Store haría falta una cuenta de desarrollador de Apple de pago.

## Más adelante: iPhone y Android

El código ya está preparado para móviles. El mismo proyecto de `ios/` se puede ejecutar en un iPhone desde Xcode.
Para Android: `npm install @capacitor/android && npx cap add android`, y luego añadir el permiso
`RECORD_AUDIO` y la consulta `android.speech.RecognitionService` en `AndroidManifest.xml`
(están en el historial de git, en el primer commit).

## Versión dentro de Claude

`artifact/index.html` es la versión original publicada como artifact de Claude
(https://claude.ai/artifact/K6ScLg7cR9EAv2TUAPdawS). Usa las capacidades del runtime de Claude
(`window.claude`) y no comparte datos con las apps.

## Límite conocido

La pronunciación se evalúa por transcripción: se marca la palabra que el reconocimiento de voz
no entendió. No hay análisis fonético ni de entonación.
