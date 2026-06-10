"""Cosmos LCD(REST) 저수준 호출 + 체인명/엔드포인트 해석."""

import requests

# 신뢰도 높은 LCD(REST) 엔드포인트. 없으면 rest.cosmos.directory 로 자동 폴백.
COSMOS_LCD = {
    "osmosis":   "https://lcd.osmosis.zone",
    "cosmoshub": "https://cosmos-rest.publicnode.com",
    "injective": "https://injective-rest.publicnode.com",
    "noble":     "https://noble-rest.publicnode.com",
    "neutron":   "https://neutron-rest.publicnode.com",
    "celestia":  "https://celestia-rest.publicnode.com",
    "kava":      "https://kava-rest.publicnode.com",
    "axelar":    "https://axelar-rest.publicnode.com",
}

# 별칭 → 정식 체인명
ALIAS = {"cosmos": "cosmoshub", "osmo": "osmosis", "inj": "injective", "tia": "celestia"}


def chain_name(chain):
    name = str(chain or "").strip().lower()
    return ALIAS.get(name, name)


def lcd_for(chain):
    name = chain_name(chain)
    return COSMOS_LCD.get(name) or f"https://rest.cosmos.directory/{name}"


def get_json(url):
    try:
        return requests.get(url, timeout=20, headers={"accept": "application/json"}).json()
    except Exception:
        return None
