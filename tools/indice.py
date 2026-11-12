#!/usr/bin/env python3
"""Regenera index.json a partir de mappings/ y ratings/.

Trata todo el contenido como datos: lo que no se puede leer se saltea.
"""
import json
import os
import sys
from datetime import datetime, timezone

RAIZ = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def cargar(ruta):
    try:
        with open(ruta, encoding="utf-8-sig") as f:
            dato = json.load(f)
        return dato if isinstance(dato, dict) else None
    except (OSError, ValueError):
        return None


def opiniones(id_mapeo):
    carpeta = os.path.join(RAIZ, "ratings", *id_mapeo.split("/"))
    puntajes, textos = [], []
    if not os.path.isdir(carpeta):
        return None, textos
    for nombre in sorted(os.listdir(carpeta)):
        dato = cargar(os.path.join(carpeta, nombre)) if nombre.endswith(".json") else None
        if dato is None:
            continue
        p = dato.get("puntaje")
        if isinstance(p, int) and not isinstance(p, bool) and 1 <= p <= 10:
            puntajes.append(p)
        else:
            p = None
        obs = dato.get("observaciones")
        if isinstance(obs, str) and obs.strip():
            textos.append({
                "usuario": str(dato.get("usuario", "")),
                "observaciones": obs.strip(),
                "fecha": str(dato.get("fecha", "")),
                "puntaje": p,
            })
    promedio = round(sum(puntajes) / len(puntajes), 1) if puntajes else None
    return promedio, textos


def generar():
    mapeos = []
    base = os.path.join(RAIZ, "mappings")
    for carpeta, _, archivos in os.walk(base):
        if "meta.json" not in archivos:
            continue
        meta = cargar(os.path.join(carpeta, "meta.json"))
        if meta is None:
            continue
        id_mapeo = os.path.relpath(carpeta, base).replace(os.sep, "/")
        if id_mapeo.count("/") != 3:
            continue
        lista = []
        for a in meta.get("archivos") or []:
            if not isinstance(a, dict):
                continue
            ruta = os.path.join(carpeta, str(a.get("nombre", "")))
            if os.path.isfile(ruta):
                lista.append({"nombre": a["nombre"], "rol": a.get("rol", "mapeo"), "bytes": os.path.getsize(ruta)})
        if not lista:
            continue
        promedio, textos = opiniones(id_mapeo)
        mapeos.append({
            "id": id_mapeo,
            "software": id_mapeo.split("/")[0],
            "marca": str(meta.get("marca", "")),
            "modelo": str(meta.get("modelo", "")),
            "nombre": str(meta.get("nombre", "")),
            "observaciones": str(meta.get("observaciones", "")),
            "autor": str(meta.get("autor", "")),
            "fecha": str(meta.get("fecha", "")),
            "puntaje": promedio,
            "archivos": lista,
            "opiniones": textos,
        })
    mapeos.sort(key=lambda m: m["id"])
    return mapeos


def main():
    mapeos = generar()
    destino = os.path.join(RAIZ, "index.json")
    anterior = cargar(destino)
    if anterior is not None and anterior.get("mapeos") == mapeos:
        print(f"index.json sin cambios ({len(mapeos)} mapeos)")
        return 0
    with open(destino, "w", encoding="utf-8", newline="\n") as f:
        json.dump({"generado": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"), "mapeos": mapeos},
                  f, ensure_ascii=False, indent=1)
        f.write("\n")
    print(f"index.json actualizado ({len(mapeos)} mapeos)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
