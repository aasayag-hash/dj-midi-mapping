#!/usr/bin/env python3
"""Valida un aporte (pull request) antes de fusionarlo.

Lee el aporte solo como datos, con git: nunca ejecuta ni importa nada de él.
Uso: validar.py --base origin/main --head aporte --autor <login del autor del PR>
Sale con 0 si está bien; si no, lista los problemas y sale con 1.
"""
import argparse
import json
import re
import subprocess
import sys

SOFTWARE = ["traktor", "virtualdj", "djay", "mixxx", "rekordbox", "serato"]
EXTENSIONES = (".tsi", ".xml", ".js", ".djaymidimapping", ".csv")
ROLES = ("mapeo", "definicion", "script")
MAX_ARCHIVO = 2 * 1024 * 1024
MAX_TOTAL = 5 * 1024 * 1024
MAX_OPINION = 8 * 1024
MAX_OBSERVACIONES = 2000
MAX_NOMBRE = 100
SLUG = re.compile(r"^[a-z0-9][a-z0-9._-]{0,79}$")
ARCHIVO = re.compile(r'^[^/\\:*?"<>|\x00-\x1f]{1,120}$')
OPINION = re.compile(r"^[0-9A-Za-z._-]{1,80}\.json$")
CONTROL = re.compile(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]")


def git(*args, check=True):
    r = subprocess.run(["git", "-c", "core.quotepath=off", *args], capture_output=True)
    if check and r.returncode != 0:
        raise RuntimeError(r.stderr.decode("utf-8", "replace"))
    return r


def existe(ref, ruta):
    return git("cat-file", "-e", f"{ref}:{ruta}", check=False).returncode == 0


def leer(ref, ruta):
    return git("show", f"{ref}:{ruta}").stdout


def tamano(ref, ruta):
    return int(git("cat-file", "-s", f"{ref}:{ruta}").stdout.strip())


def listar(ref, carpeta):
    r = git("ls-tree", "-z", "--name-only", ref, carpeta + "/", check=False)
    if r.returncode != 0:
        return []
    return [n.rsplit("/", 1)[-1] for n in r.stdout.decode("utf-8", "replace").split("\0") if n]


def cambios(base, head):
    out = git("diff", "--name-status", "-z", "--no-renames", f"{base}...{head}").stdout.decode("utf-8", "replace")
    partes = [p for p in out.split("\0") if p]
    return list(zip(partes[0::2], partes[1::2]))


def texto(valor, maximo, vacio=False):
    """True si es texto plano, sin caracteres de control y dentro del largo."""
    if not isinstance(valor, str):
        return False
    if not vacio and not valor.strip():
        return False
    return len(valor) <= maximo and not CONTROL.search(valor)


def cargar_json(ref, ruta):
    try:
        dato = json.loads(leer(ref, ruta).decode("utf-8-sig"))
        return dato if isinstance(dato, dict) else None
    except (ValueError, UnicodeDecodeError, RuntimeError):
        return None


def validar_mapeo(carpeta, base, head, autor, errores):
    software = carpeta.split("/")[1]
    meta_base = cargar_json(base, carpeta + "/meta.json") if existe(base, carpeta + "/meta.json") else None
    if meta_base is not None and str(meta_base.get("autor", "")).lower() != autor.lower():
        errores.append(f"{carpeta}: es un mapeo de otro usuario, no se puede modificar")
        return
    en_head = listar(head, carpeta)
    if not en_head:
        return  # el autor borró su propio mapeo
    if "meta.json" not in en_head:
        errores.append(f"{carpeta}: falta meta.json")
        return
    meta = cargar_json(head, carpeta + "/meta.json")
    if meta is None:
        errores.append(f"{carpeta}/meta.json: no es un JSON válido")
        return
    if meta.get("software") != software:
        errores.append(f"{carpeta}/meta.json: 'software' no coincide con la carpeta")
    for campo in ("marca", "modelo", "nombre"):
        if not texto(meta.get(campo), MAX_NOMBRE):
            errores.append(f"{carpeta}/meta.json: '{campo}' falta o es demasiado largo")
    if not texto(meta.get("observaciones", ""), MAX_OBSERVACIONES, vacio=True):
        errores.append(f"{carpeta}/meta.json: 'observaciones' debe ser texto de hasta {MAX_OBSERVACIONES} caracteres")
    if not texto(meta.get("fecha"), 40):
        errores.append(f"{carpeta}/meta.json: falta 'fecha'")
    if str(meta.get("autor", "")).lower() != autor.lower():
        errores.append(f"{carpeta}/meta.json: 'autor' tiene que ser quien envía el aporte ({autor})")
    archivos = meta.get("archivos")
    if not isinstance(archivos, list) or not archivos or not all(isinstance(a, dict) for a in archivos):
        errores.append(f"{carpeta}/meta.json: 'archivos' tiene que listar los archivos del mapeo")
        return
    nombres = [a.get("nombre") for a in archivos]
    if any(a.get("rol") not in ROLES for a in archivos):
        errores.append(f"{carpeta}/meta.json: cada archivo lleva un 'rol' ({', '.join(ROLES)})")
    if not any(a.get("rol") == "mapeo" for a in archivos):
        errores.append(f"{carpeta}/meta.json: tiene que haber al menos un archivo con rol 'mapeo'")
    reales = sorted(n for n in en_head if n != "meta.json")
    if sorted(str(n) for n in nombres) != reales:
        errores.append(f"{carpeta}: los archivos de la carpeta no coinciden con los de meta.json")


def validar_opinion(ruta, estado, base, head, autor, errores):
    if estado != "A":
        errores.append(f"{ruta}: las opiniones solo se agregan, no se modifican ni se borran")
        return
    partes = ruta.split("/")
    mapeo = "mappings/" + "/".join(partes[1:5]) + "/meta.json"
    if not existe(base, mapeo) and not existe(head, mapeo):
        errores.append(f"{ruta}: no existe ese mapeo")
        return
    if tamano(head, ruta) > MAX_OPINION:
        errores.append(f"{ruta}: demasiado grande")
        return
    dato = cargar_json(head, ruta)
    if dato is None:
        errores.append(f"{ruta}: no es un JSON válido")
        return
    puntaje = dato.get("puntaje")
    observaciones = dato.get("observaciones", "")
    if puntaje is not None and (isinstance(puntaje, bool) or not isinstance(puntaje, int) or not 1 <= puntaje <= 10):
        errores.append(f"{ruta}: 'puntaje' tiene que ser un número entero de 1 a 10")
    if not texto(observaciones, MAX_OBSERVACIONES, vacio=True):
        errores.append(f"{ruta}: 'observaciones' debe ser texto de hasta {MAX_OBSERVACIONES} caracteres")
    if puntaje is None and not str(observaciones).strip():
        errores.append(f"{ruta}: tiene que traer un puntaje o una observación")
    if str(dato.get("usuario", "")).lower() != autor.lower():
        errores.append(f"{ruta}: 'usuario' tiene que ser quien envía el aporte ({autor})")


def validar(base, head, autor):
    errores = []
    lista = cambios(base, head)
    if not lista:
        return ["El aporte no trae cambios"]
    total = 0
    mapeos = set()
    for estado, ruta in lista:
        partes = ruta.split("/")
        raiz = partes[0]
        if raiz not in ("mappings", "ratings") or len(partes) != 6:
            errores.append(f"{ruta}: solo se aceptan archivos en mappings/<software>/<marca>/<modelo>/<nombre>/ y ratings/")
            continue
        if partes[1] not in SOFTWARE:
            errores.append(f"{ruta}: software desconocido (se aceptan: {', '.join(SOFTWARE)})")
            continue
        if not all(SLUG.match(p) for p in partes[1:5]):
            errores.append(f"{ruta}: las carpetas van en minúsculas, con letras, números y guiones")
            continue
        nombre = partes[5]
        if raiz == "ratings":
            if not OPINION.match(nombre):
                errores.append(f"{ruta}: nombre de archivo inválido")
            else:
                validar_opinion(ruta, estado, base, head, autor, errores)
            continue
        mapeos.add("/".join(partes[:5]))
        if estado == "D":
            continue
        if not ARCHIVO.match(nombre) or nombre.startswith("."):
            errores.append(f"{ruta}: nombre de archivo inválido")
            continue
        if nombre != "meta.json" and not nombre.lower().endswith(EXTENSIONES):
            errores.append(f"{ruta}: tipo de archivo no permitido (se aceptan {', '.join(EXTENSIONES)})")
            continue
        peso = tamano(head, ruta)
        total += peso
        if peso > MAX_ARCHIVO:
            errores.append(f"{ruta}: supera los {MAX_ARCHIVO // (1024 * 1024)} MB")
    if total > MAX_TOTAL:
        errores.append(f"El aporte supera los {MAX_TOTAL // (1024 * 1024)} MB en total")
    for carpeta in sorted(mapeos):
        validar_mapeo(carpeta, base, head, autor, errores)
    return errores


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--base", required=True)
    ap.add_argument("--head", required=True)
    ap.add_argument("--autor", required=True)
    a = ap.parse_args()
    sys.stdout.reconfigure(encoding="utf-8")
    errores = validar(a.base, a.head, a.autor)
    if errores:
        print("El aporte no se pudo aceptar:")
        for e in errores:
            print(f"- {e}")
        return 1
    print("OK")
    return 0


if __name__ == "__main__":
    sys.exit(main())
