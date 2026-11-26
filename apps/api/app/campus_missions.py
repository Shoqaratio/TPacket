"""Starter practicals, stored in the standard versioned exercise and assignment tables."""


def lan(addresses, ipv6=None):
    devices = [dict(id="d1", model="2960-24TT", name="SW1", x=320, y=90,
                    powered=True, macBase="000af3000001", modules={})]
    links = []
    for index, ip in enumerate(addresses, 1):
        name = f"PC{index}"
        device_id = f"d{index + 1}"
        devices.append(dict(id=device_id, model="PC", name=name, x=120 + (index - 1) * 190, y=310,
                            powered=True, macBase=f"000af3{index * 64 + 1:06x}", modules={},
                            host=dict(ip=ip, mask="255.255.255.0", ipv6=ipv6[index - 1] if ipv6 else "",
                                      ipMode="static", ipv6Mode="static", gateway="", dns="", portUp=True)))
        links.append(dict(id=f"l{index}", cable="straight", a=dict(device=device_id, port="FastEthernet0"),
                          b=dict(device="d1", port=f"FastEthernet0/{index}")))
    return dict(format="netlab", schemaVersion=1, name="TPacket Campus", devices=devices, links=links,
                counters=dict(device=20, link=len(links), mac=512, note=0))


def ping(identifier, source, destination, expected="success", kind="connectivity_test"):
    return dict(id=identifier, type=kind, source=source, destination=destination, expected=expected, points=1)


def service_lab(service):
    project = lan(["192.168.50.10", "192.168.50.20"])
    server = project["devices"][2]
    server.update(model="Server", name="SRV1", services=service)
    if "dns" in service:
        project["devices"][1]["host"]["dns"] = "192.168.50.20"
    else:
        project["devices"][1]["host"].update(ip="", ipMode="dhcp")
    return project


def routed_lab():
    project = lan(["192.168.10.10", "192.168.20.10"])
    switch, pc1, pc2 = project["devices"]
    switch.update(model="1941", name="R1", x=120, y=90)
    r2 = dict(switch, id="d4", name="R2", x=310, macBase="000af30000c1")
    project["devices"].append(r2)
    pc1["host"]["gateway"], pc2["host"]["gateway"] = "192.168.10.1", "192.168.20.1"
    for index, router in enumerate((switch, r2), 1):
        router["running"] = (
            f"interface GigabitEthernet0/0\nip address 192.168.{index * 10}.1 255.255.255.0\nno shutdown\nexit\n"
            f"interface GigabitEthernet0/1\nip address 10.0.0.{index} 255.255.255.252\nno shutdown\nexit"
        )
    project["links"] = [
        dict(id="l1", cable="crossover", a=dict(device="d2", port="FastEthernet0"), b=dict(device="d1", port="GigabitEthernet0/0")),
        dict(id="l2", cable="crossover", a=dict(device="d3", port="FastEthernet0"), b=dict(device="d4", port="GigabitEthernet0/0")),
        dict(id="l3", cable="crossover", a=dict(device="d1", port="GigabitEthernet0/1"), b=dict(device="d4", port="GigabitEthernet0/1")),
    ]
    return project


TEMPLATES = {
    "ipv4-support": dict(
        title="Atelier Mistral · Un poste isolé", room="network", skill="addressing",
        statement=("Contexte — À l’ouverture de l’atelier, le poste PC2 ne communique pas avec PC1.\n"
                   "Objectif — Rétablir la connectivité IPv4 dans le réseau 192.168.10.0/24. Conservez PC1 en 192.168.10.10. "
                   "Vous pouvez choisir une adresse libre pour PC2. Vérifiez le ping dans les deux sens.\n"
                   "Initiation · 15 min · Prérequis : connaître IPv4 et le masque /24.\n"
                   "Indice — Comparez les parties réseau des deux adresses avant de modifier le câblage. "
                   "La correction rejoue les pings dans les deux sens."),
        project=lan(["192.168.10.10", "192.168.20.20"]),
        criteria=[ping("aller", "PC2", "192.168.10.10"), ping("retour", "PC1", "PC2")],
    ),
    "ipv6-pilot": dict(
        title="Médiathèque Atlas · Pilote IPv6", room="network", skill="ipv6",
        statement=("Contexte — La médiathèque prépare la migration d’un îlot de consultation. Les postes continuent à utiliser IPv4.\n"
                   "Objectif — Ajouter un adressage IPv6 statique à PC2 dans 2001:db8:10::/64. "
                   "Préserver l’adresse de PC1 (2001:db8:10::10) et vérifier la communication IPv6.\n"
                   "Initiation · 20 min · Prérequis : savoir lire un préfixe IPv6.\n"
                   "Indice — Sur un même lien, la passerelle IPv6 n’est pas nécessaire pour joindre un voisin. "
                   "La correction vérifie la communication IPv6 et le maintien d’IPv4."),
        project=lan(["192.168.10.10", "192.168.10.20"], ["2001:db8:10::10/64", ""]),
        criteria=[ping("ipv6", "PC2", "2001:db8:10::10", kind="ipv6_connectivity"), ping("ipv4", "PC2", "PC1")],
    ),
    "vlan-office": dict(
        title="Bureau Lumen · Cloisonner deux services", room="switching", skill="switching",
        statement=("Contexte — Le service accueil partage un commutateur avec la comptabilité.\n"
                   "Objectif — Placer PC1 et PC2 dans le VLAN 10, PC3 et PC4 dans le VLAN 20. "
                   "Conservez l’adressage initial. Vérifiez qu’un ping réussit dans chaque service et échoue entre services.\n"
                   "Intermédiaire · 30 min · Prérequis : CLI et ports d’accès.\n"
                   "Indice — Les ports Fa0/1 à Fa0/4 sont câblés dans le même ordre que les postes."),
        project=lan([f"192.168.10.{i}" for i in range(11, 15)]),
        criteria=[
            ping("accueil", "PC1", "PC2"), ping("comptabilite", "PC3", "PC4"),
            ping("isolation", "PC1", "PC3", "fail"),
            *[dict(id=f"port{i}", type="switchport_access", device="SW1", interface=f"FastEthernet0/{i}",
                   vlan=10 if i <= 2 else 20, points=1) for i in range(1, 5)],
        ],
    ),
    "routing-buildings": dict(
        title="Studio Rivage · Deux bâtiments", room="routing", skill="routing",
        statement=("Contexte — Le studio ouvre un second bâtiment. Les interfaces des deux routeurs sont configurées.\n"
                   "Objectif — Relier les réseaux 192.168.10.0/24 et 192.168.20.0/24 par routage statique. "
                   "Conservez le câblage, les passerelles et les adresses existantes. La liaison de transit est 10.0.0.0/30.\n"
                   "Intermédiaire · 25 min · Prérequis : routage IPv4 et CLI.\n"
                   "Indice — Chaque bâtiment doit connaître le prochain saut vers le réseau distant."),
        project=routed_lab(),
        criteria=[ping("aller", "PC1", "PC2"), ping("retour", "PC2", "PC1")],
    ),
    "dns-catalog": dict(
        title="Bibliothèque Ondine · Nom introuvable", room="datacenter", skill="services",
        statement=("Contexte — Le catalogue est joignable par son adresse mais son nom renvoie vers une ancienne adresse.\n"
                   "Objectif — Faire résoudre catalogue.ondine.test vers 192.168.50.20 depuis PC1, "
                   "sans modifier l’adresse du serveur. Conservez l’accès HTTP depuis PC1.\n"
                   "Initiation · 20 min · Prérequis : comprendre le rôle du DNS.\n"
                   "Indice — Comparez l’enregistrement A à l’adresse réelle du serveur."),
        project=service_lab({"dns": {"enabled": True, "records": [{"name": "catalogue.ondine.test", "ip": "192.168.50.99"}]}}),
        criteria=[
            dict(id="nom", type="dns_resolution", source="PC1", name="catalogue.ondine.test", expected="192.168.50.20", points=1),
            dict(id="http", type="service_access", source="PC1", destination="SRV1", service="http", expected="allowed", points=1),
        ],
    ),
    "dhcp-classroom": dict(
        title="Lycée Brume · Adresses en attente", room="datacenter", skill="services",
        statement=("Contexte — Après une modification sur SRV1, un poste de la salle ne reçoit plus d’adresse.\n"
                   "Objectif — Rétablir le bail DHCP de PC1 dans 192.168.50.0/24 et la connectivité avec SRV1. "
                   "Le serveur reste en 192.168.50.20 et le client doit rester en mode DHCP.\n"
                   "Initiation · 20 min · Prérequis : adressage IPv4 et bail DHCP.\n"
                   "Indice — Vérifiez l’état du service avant de recréer le pool."),
        project=service_lab({"dhcp": {"enabled": False, "pools": [
            dict(name="salle", start="192.168.50.100", mask="255.255.255.0", max=40, dns="", gateway=""),
        ]}}),
        criteria=[dict(id="bail", type="dhcp_client", device="PC1", points=1), ping("lien", "PC1", "SRV1")],
    ),
}
