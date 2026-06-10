"""프로젝트 루트의 .env 를 읽어 os.environ 에 주입 (외부 의존성 없는 최소 로더).

src 임포트 시 1회 실행되어, 이후 어댑터들이 os.environ 으로 비밀 설정을 읽는다.
"""

import os


def load_env():
    """프로젝트 루트(.../get_token_bridge_address/.env)를 찾아 환경변수로 로드."""
    # src/config.py → 부모(src) → 부모(프로젝트 루트)
    root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    path = os.path.join(root, ".env")
    if not os.path.exists(path):
        return
    try:
        with open(path, encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if not line or line.startswith("#") or "=" not in line:
                    continue
                key, _, val = line.partition("=")
                key, val = key.strip(), val.strip().strip('"').strip("'")
                # 이미 셸 환경변수로 설정돼 있으면 그것을 우선(덮어쓰지 않음)
                os.environ.setdefault(key, val)
    except Exception:
        pass
