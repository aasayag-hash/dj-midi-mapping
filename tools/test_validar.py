#!/usr/bin/env python3
"""Pruebas de validar.py sobre repos git temporales. Correr: python tools/test_validar.py"""
import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest

AQUI = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, AQUI)
import validar  # noqa: E402

MAPEO = "mappings/mixxx/vestax/vci-400/prueba-ana"


def meta(autor="ana", **cambios):
    m = {"software": "mixxx", "marca": "Vestax", "modelo": "VCI-400", "nombre": "Prueba", "observaciones": "ok",
         "autor": autor, "fecha": "2026-11-11T00:00:00Z", "archivos": [{"nombre": "a.midi.xml", "rol": "mapeo"}]}
    m.update(cambios)
    return json.dumps(m)


class Repo(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp(prefix="djmm_")
        self.anterior = os.getcwd()
        os.chdir(self.dir)
        self.git("init", "-q", "-b", "main")
        self.git("config", "user.email", "t@t")
        self.git("config", "user.name", "t")
        self.escribir({"README.md": "x"})
        self.git("commit", "-qm", "base")

    def tearDown(self):
        os.chdir(self.anterior)
        shutil.rmtree(self.dir, ignore_errors=True)

    def git(self, *a):
        subprocess.run(["git", *a], check=True, capture_output=True)

    def escribir(self, archivos):
        for ruta, contenido in archivos.items():
            os.makedirs(os.path.dirname(ruta) or ".", exist_ok=True)
            with open(ruta, "wb") as f:
                f.write(contenido if isinstance(contenido, bytes) else contenido.encode("utf-8"))
        self.git("add", "-A")

    def aporte(self, archivos, borrar=()):
        self.git("checkout", "-qb", "aporte")
        for b in borrar:
            os.remove(b)
        self.escribir(archivos)
        self.git("commit", "-qm", "aporte")
        return validar.validar("main", "aporte", "ana")

    def publicar(self, archivos):
        """Deja archivos ya fusionados en main."""
        self.escribir(archivos)
        self.git("commit", "-qm", "previo")

    def test_mapeo_valido(self):
        self.assertEqual([], self.aporte({MAPEO + "/meta.json": meta(), MAPEO + "/a.midi.xml": "<x/>"}))

    def test_mapeo_con_puntaje_inicial(self):
        r = "ratings/mixxx/vestax/vci-400/prueba-ana/20261111T000000Z-ab12.json"
        self.assertEqual([], self.aporte({MAPEO + "/meta.json": meta(), MAPEO + "/a.midi.xml": "<x/>",
                                          r: json.dumps({"puntaje": 8, "usuario": "ana", "fecha": "x"})}))

    def test_fuera_de_las_carpetas(self):
        self.assertTrue(self.aporte({".github/workflows/x.yml": "x"}))
        self.git("checkout", "-q", "main")

    def test_no_toca_scripts(self):
        self.assertTrue(self.aporte({"tools/validar.py": "x"}))

    def test_extension_no_permitida(self):
        self.assertTrue(self.aporte({MAPEO + "/meta.json": meta(archivos=[{"nombre": "a.exe", "rol": "mapeo"}]),
                                     MAPEO + "/a.exe": "MZ"}))

    def test_autor_distinto(self):
        self.assertTrue(self.aporte({MAPEO + "/meta.json": meta(autor="otro"), MAPEO + "/a.midi.xml": "<x/>"}))

    def test_archivo_sin_declarar(self):
        self.assertTrue(self.aporte({MAPEO + "/meta.json": meta(), MAPEO + "/a.midi.xml": "<x/>", MAPEO + "/b.js": "1"}))

    def test_software_desconocido(self):
        d = "mappings/otro/vestax/vci-400/p"
        self.assertTrue(self.aporte({d + "/meta.json": meta(software="otro"), d + "/a.midi.xml": "<x/>"}))

    def test_archivo_demasiado_grande(self):
        self.assertTrue(self.aporte({MAPEO + "/meta.json": meta(), MAPEO + "/a.midi.xml": b"x" * (validar.MAX_ARCHIVO + 1)}))

    def test_no_modifica_mapeo_ajeno(self):
        d = "mappings/mixxx/vestax/vci-400/de-otro"
        self.publicar({d + "/meta.json": meta(autor="otro"), d + "/a.midi.xml": "<x/>"})
        self.assertTrue(self.aporte({d + "/a.midi.xml": "<y/>"}))

    def test_no_borra_mapeo_ajeno(self):
        d = "mappings/mixxx/vestax/vci-400/de-otro"
        self.publicar({d + "/meta.json": meta(autor="otro"), d + "/a.midi.xml": "<x/>"})
        self.assertTrue(self.aporte({}, borrar=[d + "/meta.json", d + "/a.midi.xml"]))

    def test_actualiza_mapeo_propio(self):
        self.publicar({MAPEO + "/meta.json": meta(), MAPEO + "/a.midi.xml": "<x/>"})
        self.assertEqual([], self.aporte({MAPEO + "/a.midi.xml": "<y/>"}))

    def opinion(self, dato, nombre="20261111T000000Z-ab12.json"):
        self.publicar({MAPEO + "/meta.json": meta(), MAPEO + "/a.midi.xml": "<x/>"})
        return self.aporte({"ratings/mixxx/vestax/vci-400/prueba-ana/" + nombre: json.dumps(dato)})

    def test_puntaje_valido(self):
        self.assertEqual([], self.opinion({"puntaje": 10, "usuario": "ana", "fecha": "x"}))

    def test_solo_observacion(self):
        self.assertEqual([], self.opinion({"observaciones": "Anda bien", "usuario": "ana", "fecha": "x"}))

    def test_puntaje_fuera_de_rango(self):
        self.assertTrue(self.opinion({"puntaje": 11, "usuario": "ana"}))

    def test_puntaje_no_entero(self):
        self.assertTrue(self.opinion({"puntaje": "9", "usuario": "ana"}))

    def test_opinion_vacia(self):
        self.assertTrue(self.opinion({"usuario": "ana"}))

    def test_observacion_larga(self):
        self.assertTrue(self.opinion({"observaciones": "x" * 2001, "usuario": "ana"}))

    def test_opinion_de_mapeo_inexistente(self):
        self.assertTrue(self.aporte({"ratings/mixxx/vestax/vci-400/no-existe/a.json": json.dumps({"puntaje": 5, "usuario": "ana"})}))

    def test_no_modifica_opinion_existente(self):
        r = "ratings/mixxx/vestax/vci-400/prueba-ana/vieja.json"
        self.publicar({MAPEO + "/meta.json": meta(), MAPEO + "/a.midi.xml": "<x/>",
                       r: json.dumps({"puntaje": 1, "usuario": "otro"})})
        self.assertTrue(self.aporte({r: json.dumps({"puntaje": 10, "usuario": "ana"})}))


if __name__ == "__main__":
    unittest.main()
