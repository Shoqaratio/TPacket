# Format de projet `.netlab` (schemaVersion 1)

Fichier JSON UTF-8. Validé à l'ouverture par `validateProject` (types, tailles, modèles et ports
existants, câbles compatibles). Limites : 500 équipements, 2 000 liens, 64 Kio de configuration par
équipement.

```jsonc
{
  "format": "netlab",
  "schemaVersion": 1,
  "name": "TP routage statique",
  "devices": [
    {
      "id": "d1", "model": "1941", "name": "Router0", "x": 200, "y": 120, "powered": true,
      "macBase": "000af3000001",            // MAC des ports : macBase + index du port
      "modules": { "EHWIC0": "HWIC-2T" },
      "running": "!\nversion 15.1\n…\nend\n", // running-config IOS (texte rejoué par la CLI)
      "startup": null,                       // startup-config (NVRAM) ou null
      "rsaModulus": 1024                     // clés RSA générées (hors running-config)
    },
    { "id": "d2", "model": "2960-24TT", "name": "Switch0", "x": 0, "y": 0, "powered": true,
      "macBase": "000af3000041", "modules": {}, "running": "…", "startup": null,
      "vlanDb": [{ "id": 10, "name": "ADMIN" }] }, // vlan.dat
    { "id": "d3", "model": "PC", "name": "PC0", "x": 0, "y": 0, "powered": true,
      "macBase": "000af3000081", "modules": {},
      "host": { "ipMode": "static", "ip": "192.168.1.10", "mask": "255.255.255.0",
                "gateway": "192.168.1.1", "dns": "", "portUp": true } }
  ],
  "links": [
    { "id": "l1", "cable": "straight", "a": { "device": "d3", "port": "FastEthernet0" },
      "b": { "device": "d2", "port": "FastEthernet0/1" } }
    // "serial-dce" : l'extrémité a est DCE ; "serial-dte" : l'extrémité b est DCE
  ],
  "notes": [{ "id": "n1", "x": 0, "y": 0, "text": "…", "color": "#facc15" }],
  "zones": [{ "id": "z2", "x": 0, "y": 0, "w": 320, "h": 220, "label": "LAN Compta", "color": "#6366f1" }],
  "counters": { "device": 3, "link": 1, "mac": 192, "note": 2 }
}
```

## Évolutions prévues
- **schemaVersion 2** : archive ZIP (`project.json` + `resources/`) pour embarquer images et pages HTML
  des serveurs ; un convertisseur v1 → v2 sera fourni.
- **`.netactivity`** : archive contenant `activity.json` (énoncé, objectifs, paramètres), `initial.netlab`,
  `solutions/*.netlab` et `rubric.json` (format `Rubric` de `packages/engine/src/grading/grader.ts`).
- `.pkt` / `.pka` : formats propriétaires chiffrés, non pris en charge. Un assistant de migration pourra
  reconstruire une topologie à partir des configurations texte exportées depuis Packet Tracer
  (déjà possible équipement par équipement : Config › Importer une configuration).
