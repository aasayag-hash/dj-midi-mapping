# dj-midi-mapping

Biblioteca abierta de mapeos MIDI para controladores de DJ, ordenada por software, marca y modelo.

Es el almacén que usa la solapa **Mapeos online** de [DJ Backup Manager](https://github.com/aasayag-hash/bak-res-djtool): desde la app se buscan, se bajan, se suben y se puntúan los mapeos. También se pueden bajar a mano desde acá.

## Qué hay

```
mappings/<software>/<marca>/<modelo>/<nombre>/
    meta.json      datos del mapeo y observaciones del autor
    ...            los archivos del mapeo
ratings/<software>/<marca>/<modelo>/<nombre>/
    *.json         un archivo por cada puntaje u observación enviada
index.json         lista de todos los mapeos con su puntaje promedio (se genera sola)
```

Software aceptados: `traktor`, `virtualdj`, `djay`, `mixxx`, `rekordbox`, `serato`.

## Cómo aportar

Lo más simple es hacerlo desde la app: conectás tu cuenta de GitHub, elegís el archivo, completás software, marca, modelo y observaciones, y listo.

A mano también se puede, con un pull request que respete la estructura de arriba. Cada pull request se revisa de forma automática y, si está bien, se fusiona solo. Reglas:

- Solo archivos dentro de `mappings/` y `ratings/`.
- Tipos permitidos: `.tsi`, `.xml`, `.js`, `.djayMidiMapping`, `.csv` y el `meta.json`.
- Hasta 2 MB por archivo y 5 MB por aporte.
- Las carpetas van en minúsculas, con letras, números y guiones.
- En `meta.json`, `autor` es tu usuario de GitHub. Solo el autor puede modificar o borrar su mapeo.
- Los puntajes van de 1 a 10; las observaciones, hasta 2000 caracteres.

Ejemplo de `meta.json`:

```json
{
  "software": "mixxx",
  "marca": "Vestax",
  "modelo": "VCI-400",
  "nombre": "Mapeo de fábrica de Mixxx",
  "observaciones": "4 decks, jog con scratch, LEDs.",
  "autor": "tu-usuario",
  "fecha": "2026-11-11T12:00:00Z",
  "archivos": [
    { "nombre": "Vestax VCI-400.midi.xml", "rol": "mapeo" },
    { "nombre": "Vestax-VCI-400-scripts.js", "rol": "script" }
  ]
}
```

Roles de archivo: `mapeo` (el archivo principal), `definicion` (definición del dispositivo de VirtualDJ) y `script` (JavaScript de Mixxx).

## Aviso

Los mapeos los suben los usuarios y se publican sin revisión manual. Los de Mixxx pueden traer JavaScript: mirá de quién es antes de usarlo. Cada mapeo pertenece a su autor.
