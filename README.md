# Ordena

Aplicación de escritorio para **Windows y macOS** que analiza una carpeta, propone cómo **organizar tus archivos** y te ayuda a **liberar espacio**, con la ayuda de la IA de [MiniMax](https://platform.minimax.io).

- **Análisis local**: qué ocupa espacio por tipo, tamaño y antigüedad; duplicados exactos; archivos temporales; carpetas vacías.
- **Explorar un disco completo**: analiza `C:\`, `Macintosh HD` o la carpeta de usuario entera y navega por las carpetas ordenadas por tamaño. Cada carpeta se etiqueta (sistema, aplicaciones, caché, usuario, juegos, desarrollo…) y las conocidas traen una explicación de qué son y cómo reducirlas. El botón **Explicar con IA** pide a MiniMax un plan concreto para ese nivel.
- **Archivos por tipo**: pulsa una categoría, una extensión, un tramo de antigüedad o los mosaicos de temporales y grandes sin uso para ver la lista de esos archivos, dónde están concentrados, buscar dentro, seleccionarlos en bloque y enviarlos a la Papelera o moverlos a otro disco.
- **Actualizaciones parciales y caché**: cada análisis se guarda en disco y se reabre en segundos desde "Análisis guardados". Al mover o borrar desde la app solo se releen las carpetas afectadas, y el botón "Actualizar esta carpeta" del explorador vuelve a leer únicamente esa carpeta y su contenido, sin recorrer el disco entero.
- **Mover a otro disco**: copia una carpeta pesada (Vídeos, bibliotecas de juegos, Docker, copias de iPhone…) a otro disco, verifica la copia, borra el original y deja un enlace (junction en Windows, symlink en macOS) para que los programas la sigan encontrando. Reversible desde Historial.
- **Organizar con IA**: MiniMax propone una estructura de carpetas y movimientos concretos. Tú revisas, marcas lo que quieres y aplicas. Todo se puede **deshacer** desde Historial.
- **Liberar espacio con IA**: sugerencias con nivel de confianza (alta / media / baja) y motivo. Los archivos van a la **Papelera**, nunca se borran directamente.
- **Preguntar**: chat con contexto de la carpeta ("¿qué puedo borrar para ganar 5 GB?").
- **Seguridad primero**: cada carpeta se clasifica como sistema, aplicación, caché, personal u otro. Lo del sistema nunca se toca; los datos de aplicaciones y juegos no se proponen para borrar (salvo que actives el modo avanzado) y, si insistes, la confirmación nombra las aplicaciones afectadas. Lo que eliminas va a la **cuarentena de Ordena**: se restaura con un clic desde Historial y el espacio se libera cuando la vacías.
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

Al analizar un disco completo o la carpeta de usuario, Ordena pasa a un modo ligero: calcula el tamaño de todas las carpetas y guarda el detalle solo de los archivos de 1 MB o más. Las carpetas del sistema (`Windows`, `Program Files`, `/System`, `/Library`…) se muestran pero están protegidas: nunca se mueven ni se borran, y tampoco se tocan `.git` ni `node_modules`.

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
| `ORDENA_DEV_SCAN=/ruta` | Analiza esa carpeta al arrancar (`ORDENA_DEV_SCAN_MODE=disk` fuerza el modo disco, `ORDENA_DEV_SCAN_CACHE=1` abre el análisis guardado) |
| `ORDENA_DEV_VIEW=organize` | Muestra esa vista al arrancar |
| `ORDENA_DEV_ACTION=organize\|cleanup\|dupes\|explain\|refresh` | Dispara esa acción al arrancar |
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
  scanner.js     recorrido de carpetas, tamaños y categorías por carpeta, actualización incremental, duplicados
  cache.js       análisis guardados (JSON comprimido en la carpeta de datos de la app)
  diskinfo.js    discos montados y espacio libre, base de conocimiento de rutas del sistema, rutas protegidas
  safety.js      clasificación de propiedad (sistema / aplicación / caché / personal) y tope de confianza por tipo
  planner.js     prompts para MiniMax y validación de sus respuestas (rutas seguras, sin cambiar extensiones)
  minimax.js     cliente de la API compatible con OpenAI (Bearer, manejo de <think>, errores base_resp)
  operations.js  mover, trasladar a otro disco, cuarentena (restaurar / vaciar), Papelera, carpetas vacías, diario
  settings.js    ajustes y clave de API cifrada con safeStorage
src/preload/     puente seguro (contextIsolation + sandbox)
src/renderer/    interfaz (HTML/CSS/JS sin dependencias)
test/            tests con node:test
```

## Licencia

MIT
