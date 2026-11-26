SKILL_CATALOG = (
    {"id": "addressing", "fr": "Adressage IP", "en": "IP addressing"},
    {"id": "switching", "fr": "Commutation", "en": "Switching"},
    {"id": "routing", "fr": "Routage", "en": "Routing"},
    {"id": "services", "fr": "Services réseau", "en": "Network services"},
    {"id": "security", "fr": "Sécurité", "en": "Security"},
    {"id": "wireless", "fr": "Réseaux sans fil", "en": "Wireless networking"},
    {"id": "ipv6", "fr": "IPv6", "en": "IPv6"},
    {"id": "troubleshooting", "fr": "Dépannage", "en": "Troubleshooting"},
)

SKILL_CODES = frozenset(skill["id"] for skill in SKILL_CATALOG)
