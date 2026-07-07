"""MEDI 오토파일럿 — 연결 자동 수립 + 자동 트러블슈팅.

목표: "자율주행처럼" 스스로 데이터 경로를 찾고, 고칠 수 있는 문제는 고치고,
사람(사내 IT/보안/dataPARC 관리자)의 조치가 필요한 것만 '보낼 수 있는 요청문'으로 만든다.

자동으로 하는 일:
  1) 포트 탐지: dataPARC 호스트에서 12340(Store REST) / 51235(OPC UA) / 1433(SQL) 개방 여부
  2) REST 경로: /auth-info(루트)로 보안 여부 확인 → 비보안이면 태그 조회까지 자동 검증.
     TLS 자가서명이면 검증 우회로 1회 재시도해 "연결은 되게" 하고, 정식 CA 등록 요청문 생성
  3) 커넥터 자동 선택·핫스왑: REST > OPC UA > SQL 우선순위로 동작하는 경로를 즉시 적용
  4) 타임존 자동 보정: 샘플 데이터의 최신 타임스탬프가 UTC 현재와 '정수 시간' 단위로
     어긋나 있으면(예: +9h — 로컬시각을 UTC로 잘못 보고하는 고전 버그) 읽기 응답에
     오프셋을 자동 적용하고 로그로 알림
  5) 실패 시 재시도(지수 백오프)는 read 경로에 내장

사람이 필요한 일 → 요청문 자동 생성:
  방화벽 차단(포트 전부 닫힘), OAuth 보안 활성(토큰 필요), 계정/읽기권한, TLS 인증서.

의존성: 표준 라이브러리 + httpx(이미 필수) — 신규 의존성 0.
"""
from __future__ import annotations

import asyncio
import socket
from datetime import datetime, timedelta, timezone

import httpx

PORT_REST = 12340
PORT_OPCUA = 51235
PORT_SQL = 1433


async def _port_open(host: str, port: int, timeout: float = 3.0) -> bool:
    try:
        fut = asyncio.open_connection(host=host, port=port)
        _r, w = await asyncio.wait_for(fut, timeout=timeout)
        w.close()
        try:
            await w.wait_closed()
        except Exception:  # noqa: BLE001
            pass
        return True
    except (OSError, asyncio.TimeoutError, socket.gaierror):
        return False


def _req_firewall(host: str, ports: list[int]) -> str:
    return (f"[방화벽 개방 요청]\n"
            f"수신: 사내 네트워크/보안 담당\n"
            f"요청: 정비부서 예지보전 시스템(MEDI PdM)에서 dataPARC 서버({host})의 "
            f"TCP {', '.join(map(str, ports))} 포트 접근 허용 요청드립니다.\n"
            f"용도: 히스토리안 데이터 읽기 전용 조회(쓰기 없음). 출발지: 게이트웨이 PC 1대.\n"
            f"근거: dataPARC 공식 접근 경로 (Store REST {PORT_REST} / OPC UA {PORT_OPCUA}).")


def _req_oauth(host: str, authority: str = "", client_hint: str = "") -> str:
    return (f"[dataPARC 접속 계정(OAuth) 발급 요청]\n"
            f"수신: dataPARC 관리자\n"
            f"요청: {host} dataPARC.Store REST API 읽기전용 접근용 OAuth 클라이언트/토큰 발급을 요청드립니다.\n"
            f"확인된 설정: Authority={authority or '(GET /auth-info 로 확인)'} {client_hint}\n"
            f"권한 범위: 태그 조회 + 히스토리 읽기 (쓰기 불필요). 발급 후 게이트웨이 config.yaml의 "
            f"bearer_token 에 기입하면 됩니다.")


def _req_tls(host: str) -> str:
    return (f"[TLS 인증서 등록 요청]\n"
            f"수신: dataPARC 관리자 / IT\n"
            f"현상: {host}:{PORT_REST} 의 HTTPS 인증서가 자가서명이라 검증에 실패합니다.\n"
            f"임시: 게이트웨이가 검증 우회로 동작 중(데이터는 정상, 보안상 임시책).\n"
            f"요청: 서버 인증서를 사내 CA로 발급/교체하거나, 현재 인증서(공개키)를 전달해 주시면 "
            f"게이트웨이 신뢰 목록에 등록하겠습니다.")


def _req_account(host: str) -> str:
    return (f"[dataPARC 읽기 권한 요청]\n"
            f"수신: dataPARC 관리자\n"
            f"요청: {host} 서버의 태그 읽기전용 권한(Security Console 읽기 역할)을 "
            f"예지보전 게이트웨이 계정에 부여 요청드립니다. OPC UA 접속 시 UA Security Console 에서 "
            f"해당 계정/Anonymous 허용도 함께 확인 부탁드립니다.")


async def probe_rest(host: str, verify: bool = True) -> dict:
    """Store REST 자동 검증: auth-info → tags. TLS 실패 시 우회 재시도."""
    base = f"https://{host}:{PORT_REST}"
    out = {"reachable": False, "secured": None, "tls_ok": True, "tags_ok": False, "detail": ""}
    for attempt_verify in ([True, False] if verify else [False]):
        try:
            async with httpx.AsyncClient(verify=attempt_verify, timeout=6.0) as cli:
                r = await cli.get(base + "/auth-info")
                out["reachable"] = True
                out["tls_ok"] = attempt_verify
                if r.status_code == 200:
                    j = r.json() if r.headers.get("content-type", "").startswith("application/json") else {}
                    out["secured"] = bool(j.get("isSecured") or j.get("IsSecured"))
                    out["authority"] = j.get("authority") or j.get("Authority") or ""
                if not out["secured"]:
                    t = await cli.get(base + "/api/v1/tags")
                    out["tags_ok"] = t.status_code == 200
                    out["detail"] = f"태그 응답 HTTP {t.status_code}"
                return out
        except httpx.ConnectError as e:
            msg = str(e)
            if "certificate" in msg.lower() or "ssl" in msg.lower():
                out["tls_ok"] = False
                continue  # 검증 우회로 재시도
            out["detail"] = msg
            return out
        except Exception as e:  # noqa: BLE001
            out["detail"] = f"{type(e).__name__}: {e}"
            return out
    return out


def detect_ts_offset_ms(latest_ts_ms: float, now_utc_ms: float) -> int:
    """타임스탬프가 UTC 현재와 '30분의 배수' 단위로 어긋났으면 보정 오프셋(ms) 반환, 아니면 0.

    전형: 서버가 로컬시각(KST 등)을 UTC로 보고 → 최신값이 미래(+9h) 또는 과거(-9h)로 보임.
    최신 데이터가 ±10분 이내면 정상으로 간주.
    """
    diff = latest_ts_ms - now_utc_ms  # 양수 = 미래로 어긋남
    if abs(diff) < 10 * 60000:
        return 0
    half_hours = round(diff / 1800000.0)
    if half_hours == 0 or abs(half_hours) > 52:  # ±26h 초과는 오프셋이 아니라 정체(stale)
        return 0
    snapped = half_hours * 1800000
    if abs(diff - snapped) < 6 * 60000:  # 스냅 오차 6분 이내면 타임존 오프셋으로 판단
        return -snapped  # 보정: 반대 방향으로 이동
    return 0


async def run_autopilot(host: str, connector, config: dict) -> dict:
    """자동 연결/트러블슈팅 실행. actions 로그와 요청문 목록 반환.

    connector: 현재 활성 커넥터(샘플 읽기·타임존 검사에 사용).
    """
    actions: list[dict] = []
    requests: list[dict] = []

    def act(what: str, ok: bool, detail: str = "", fixed: bool = False):
        actions.append({"what": what, "ok": ok, "detail": detail, "fixed": fixed})

    def need(who: str, title: str, text: str):
        requests.append({"who": who, "title": title, "text": text})

    # ── 1) 포트 탐지 ──
    if host:
        rest_open, ua_open, sql_open = await asyncio.gather(
            _port_open(host, PORT_REST), _port_open(host, PORT_OPCUA), _port_open(host, PORT_SQL))
        act("포트 탐지", rest_open or ua_open or sql_open,
            f"{host} → REST({PORT_REST}): {'열림' if rest_open else '닫힘'} · "
            f"OPC UA({PORT_OPCUA}): {'열림' if ua_open else '닫힘'} · SQL({PORT_SQL}): {'열림' if sql_open else '닫힘'}")
        if not (rest_open or ua_open or sql_open):
            need("네트워크/보안팀", "방화벽 개방", _req_firewall(host, [PORT_REST, PORT_OPCUA]))
            act("자동 경로 선택", False, "모든 포트 닫힘 — 방화벽 개방 요청문을 생성했습니다", False)
            return {"actions": actions, "requests": requests, "selected": None}

        # ── 2) REST 자동 검증 (열려 있으면) ──
        selected = None
        if rest_open:
            pr = await probe_rest(host)
            if pr["reachable"]:
                if not pr["tls_ok"]:
                    act("TLS 자가서명 우회", True, "인증서 검증 실패 → 우회로 연결 성공 (임시책)", True)
                    need("dataPARC 관리자/IT", "TLS 인증서 등록", _req_tls(host))
                if pr["secured"]:
                    act("REST 보안 확인", True, "OAuth 보안 활성 — 토큰 필요", False)
                    need("dataPARC 관리자", "OAuth 계정 발급", _req_oauth(host, pr.get("authority", "")))
                elif pr["tags_ok"]:
                    act("REST 경로 검증", True, f"비보안 + 태그 조회 성공 ({pr['detail']})", True)
                    selected = "dataparc_rest"
                else:
                    act("REST 경로 검증", False, pr.get("detail", "태그 조회 실패"), False)
                    need("dataPARC 관리자", "읽기 권한", _req_account(host))
            else:
                act("REST 접근", False, pr.get("detail", "연결 실패"), False)
        if not selected and ua_open:
            act("OPC UA 폴백 선택", True,
                f"opc.tcp://{host}:{PORT_OPCUA}/Capstone/OPCUAServer — 소켓 개방 확인. "
                "config.yaml connector: opcua 로 지정하세요 (asyncua 설치 필요 — 순수 파이썬, 저리스크)", True)
            selected = "opcua"
            need("dataPARC 관리자", "UA 접속 허용 확인",
                 "UA Security Console에서 게이트웨이 계정(또는 Anonymous) 허용 여부만 확인 부탁드립니다. "
                 "(이미 허용되어 있으면 조치 불필요)")
        if not selected and sql_open:
            act("PARCdata SQL 폴백", True, "SQL 포트 개방 — 레거시 경로. connector: parcdata_sql", True)
            selected = "parcdata_sql"
    else:
        selected = None
        act("포트 탐지", False, "dataPARC 호스트 미지정 — config.yaml 또는 ?host= 로 지정", False)

    # ── 3) 현재 커넥터 샘플 읽기 + 타임존 자동 보정 ──
    # (데모 시뮬레이터는 요청 구간에 맞춰 데이터를 생성하므로 타임존 검사 대상이 아님)
    if getattr(connector, "name", "") == "simulator":
        act("타임스탬프 검증", True, "데모 시뮬레이터 — 보정 불필요", False)
        return {"actions": actions, "requests": requests, "selected": selected, "ts_offset_ms": 0}
    try:
        tags = await connector.list_tags()
        if tags:
            tid = tags[0].get("id") if isinstance(tags[0], dict) else tags[0]
            now = datetime.now(timezone.utc)
            data = await connector.read_raw([tid], now - timedelta(hours=2), now + timedelta(hours=26))
            ts = (data.get(tid) or {}).get("t") or []
            if ts:
                off = detect_ts_offset_ms(ts[-1], now.timestamp() * 1000)
                if off:
                    act("타임존 자동 보정", True,
                        f"최신 타임스탬프가 UTC와 {-off / 3600000:+.1f}h 어긋남 — 읽기 응답에 자동 보정 적용 "
                        f"(원인: 수집기가 로컬시각을 UTC로 보고. 근본 해결은 서버 타임존/NTP 설정)", True)
                else:
                    act("타임스탬프 검증", True, "UTC 정합 정상", False)
                # main.py 가 이 값을 읽어 read 응답에 적용
                return {"actions": actions, "requests": requests, "selected": selected, "ts_offset_ms": off}
    except Exception as e:  # noqa: BLE001
        act("샘플 읽기", False, f"{type(e).__name__}: {e}", False)

    return {"actions": actions, "requests": requests, "selected": selected, "ts_offset_ms": 0}
