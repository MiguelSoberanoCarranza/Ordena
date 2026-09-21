# Ordena

Aplicación de escritorio para **Windows y macOS** que analiza una carpeta, propone cómo **organizar tus archivos** y te ayuda a **liberar espacio**, con la ayuda de la IA de [MiniMax](https://platform.minimax.io).

- **Análisis local**: qué ocupa espacio por tipo, tamaño y antigüedad; duplicados exactos; archivos temporales; carpetas vacías.
- **Organizar con IA**: MiniMax propone una estructura de carpetas y movimientos concretos. Tú revisas, marcas lo que quieres y aplicas. Todo se puede **deshacer** desde Historial.
- **Liberar espacio con IA**: sugerencias con nivel de confianza (alta / media / baja) y motivo. Los archivos van a la **Papelera**, nunca se borran directamente.
- **Preguntar**: chat con contexto de la carpeta ("¿qué puedo borrar para ganar 5 GB?").
- **Privacidad**: solo se envía a MiniMax una lista con rutas, tamaños, fechas y categorías. **Nunca el contenido de los archivos.** La clave de API se guarda cifrada con el almacén seguro del sistema (Keychain / DPAPI).

## Requisitos

- Una clave de API de MiniMax: créala en [platform.minimax.io](https://platform.minimax.io/user-center/basic-information/interface-key) (cuenta internacional) o [platform.minimaxi.com](https://platform.minimaxi.com) (China). En Ajustes puedes cambiar la URL base y el modelo (por defecto `https://api.minimax.io/v1` y `MiniMax-M2.5`).
- Para desarrollar: Node.js 20 o superior.

## Uso

1. Abre Ordena y ve a **Ajustes** → pega tu clave de MiniMax → **Probar conexión** → **Guardar**.
2. En **Carpeta**, elige Descargas, Escritorio, Documentos o cualquier otra carpeta.
3. Revisa el **Análisis** y pulsa **Buscar duplicados** si quieres.
4. En **Organizar**, añade instrucciones si quieres ("agrupa las facturas por año") y pulsa **Generar plan**. Desmarca lo que no te convenza y pulsa **Aplicar**.
5. En **Liberar espacio**, pulsa **Analizar con IA**, revisa las sugerencias y envía a la Papelera las que apruebes.
6. Si algo no te gusta, ve a **Historial** y pulsa **Deshacer**.

Por seguridad la app no permite analizar el disco completo ni la carpeta de usuario entera; elige una subcarpeta concreta. Nunca toca carpetas `.git`, `node_modules` ni similares.

## Desarrollo

```bash
npm install
npm start          # abre la app
npm test           # tests unitarios (scanner, planificador, operaciones, cliente MiniMax)
npm run lint       # comprobación de sintaxis
```

Variables útiles durante el desarrollo:

| Variable | Efecto |
|---|---|
| `MINIMAX_API_KEY` | Clave usada si no hay ninguna guardada en Ajustes |
| `ORDENA_DEV_SCAN=/ruta` | Analiza esa carpeta al arrancar |
| `ORDENA_DEV_VIEW=organize` | Muestra esa vista al arrancar |
| `ORDENA_DEV_ACTION=organize\|cleanup\|dupes` | Dispara esa acción al arrancar |
| `ORDENA_SCREENSHOT=/ruta.png` | Captura la ventana y cierra (útil en CI) |

## Generar instaladores

```bash
npm run icon        # genera build/icon.png (electron-builder crea .icns y .ico)
npm run dist:mac    # .dmg y .zip para Apple Silicon e Intel (ejecutar en macOS)
npm run dist:win    # instalador NSIS y versión portable (ejecutar en Windows)
```

Los archivos quedan en `dist/`. El workflow de GitHub Actions (`.github/workflows/build.yml`) construye ambas plataformas en cada push y publica los instaladores en una *release* al crear una etiqueta `v*`:

```bash
git tag v0.1.0 && git push origin v0.1.0
```

> Las builds no están firmadas. En macOS la primera vez hay que abrir la app con clic derecho → **Abrir**; en Windows, SmartScreen mostrará un aviso de "editor desconocido". Para evitarlo hace falta un certificado de desarrollador de Apple / de firma de código para Windows.

## Estructura

```
src/main/        proceso principal de Electron
  main.js        ventana, menú, IPC
  scanner.js     recorrido de carpetas, resumen, duplicados (sha1 por tamaño → parcial → completo)
  planner.js     prompts para MiniMax y validación de sus respuestas (rutas seguras, sin cambiar extensiones)
  minimax.js     cliente de la API compatible con OpenAI (Bearer, manejo de <think>, errores base_resp)
  operations.js  mover, enviar a la Papelera, borrar carpetas vacías, diario de operaciones y deshacer
  settings.js    ajustes y clave de API cifrada con safeStorage
src/preload/     puente seguro (contextIsolation + sandbox)
src/renderer/    interfaz (HTML/CSS/JS sin dependencias)
test/            tests con node:test
```

## Licencia

MIT
