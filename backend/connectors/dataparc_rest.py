"""dataPARC.Store REST API 커넥터 (신형 dataPARC — 1순위 권장).

공식 OpenAPI 스펙(github.com/dataPARC/store, rest/dataparcstore.json — OpenAPI 3.0.4,
렌더링: https://dataparc.github.io/store/rest/)으로 검증된 사실:

  · read 엔드포인트의 tagIds 는 **숫자 태그 ID(int32)** — "ex: 45,100,2291".
    태그 이름을 그대로 넘기면 동작하지 않는다. 이름→ID 해석이 필수:
      GET /api/v1/tags?group=&interface=&set=      ← 브라우즈/필터 (자유검색 엔드포인트는 없음)
      GET /api/v1/tags/{group}/{interface}/{name}  ← 정규화 이름으로 단건 조회
  · GET /api/v1/read/raw?tagIds&start&end (+ maxValues, skipUnitConversion 등)
    GET /api/v1/read/aggregate (aggregate 38종, interval, useUtc), /read/at-time, /read/current
  · 타임스탬프: ISO 8601 밀리초 + UTC "Z". 값에 int32 quality 동봉.
    태그별 status enum: Success / NoValues / UnknownOrInactiveTag / Unlicensed / InvalidDateRange…
  · HTTPS 전용(HTTP 미지원), 기본 포트 12340(배포 시 변경 가능).
  · 보안: GET /auth-info (루트 경로 — /api/v1 아님) → OAuth 설정 {ClientId, Authority, Scopes, IsSecured}.
    비보안 서버는 토큰 없이 동작.
  · 적용 대상: dataPARC.Store 도입 사이트(release2405+). 구형 PARChistory는 OPC UA/PARCdata 사용.

config.yaml 의 tags: 매핑은 두 형태 모두 지원:
  tags:
    PT-101: 4512                       # 숫자 ID를 이미 알 때
    TT-103: "Group/Interface/TagName"  # 정규화 이름 → 기동 시 ID로 자동 해석
"""
from __future__ import annotations

from datetime import datetime, timezone

import httpx

from .base import Connector


class DataparcRestConnector(Connector):
    name = "dataparc_rest"

    def __init__(self, cfg: dict):
        self.base = cfg["base_url"].rstrip("/")
        self.verify = cfg.get("verify_tls", True)
        self.token = cfg.get("bearer_token")
        # 웹앱 태그ID → dataPARC 식별자(숫자 ID 또는 "Group/Interface/Name")
        self.tagmap: dict[str, object] = cfg.get("tags", {}) or {}
        self.numeric: dict[str, int] = {}   # 웹앱 태그ID → 해석된 숫자 ID
        self.rev: dict[str, str] = {}       # 숫자 ID(str) → 웹앱 태그ID
        self.resolve_errors: dict[str, str] = {}
        self._client: httpx.AsyncClient | None = None

    async def start(self) -> None:
        headers = {"Accept": "application/json"}
        if self.token:
            headers["Authorization"] = f"Bearer {self.token}"
        self._client = httpx.AsyncClient(base_url=self.base, verify=self.verify,
                                         headers=headers, timeout=30.0)
        await self._resolve_ids()

    async def stop(self) -> None:
        if self._client:
            await self._client.aclose()

    async def _resolve_ids(self) -> None:
        """tags: 매핑의 식별자를 전부 숫자 ID로 해석 (read 엔드포인트는 숫자 ID만 받음)."""
        self.numeric.clear()
        self.rev.clear()
        self.resolve_errors.clear()
        for local, remote in self.tagmap.items():
            try:
                if isinstance(remote, int) or (isinstance(remote, str) and remote.isdigit()):
                    rid = int(remote)
                else:
                    # "Group/Interface/Name" (또는 "Group/Interface/Set/Name") → 단건 조회
                    parts = [p for p in str(remote).split("/") if p]
                    if len(parts) < 3:
                        raise ValueError(
                            f"식별자 '{remote}' 형식 오류 — 숫자 ID 또는 'Group/Interface/TagName' 필요")
                    r = await self._client.get("/api/v1/tags/" + "/".join(parts[:3]))
                    r.raise_for_status()
                    j = r.json()
                    rid = int(j.get("id") if isinstance(j, dict) else j[0].get("id"))
                self.numeric[local] = rid
                self.rev[str(rid)] = local
            except Exception as e:  # noqa: BLE001 — 태그별 실패는 진단으로 노출
                self.resolve_errors[local] = f"{type(e).__name__}: {e}"

    async def list_tags(self) -> list[dict]:
        out = []
        for local, remote in self.tagmap.items():
            entry = {"id": local, "desc": str(remote), "unit": ""}
            if local in self.resolve_errors:
                entry["error"] = self.resolve_errors[local]
            elif local in self.numeric:
                entry["remoteId"] = self.numeric[local]
            out.append(entry)
        return out

    async def browse_remote(self, group: str = "", interface: str = "") -> list[dict]:
        """원본 태그 브라우즈 — 매핑 작성을 돕는 유틸 (자유검색 엔드포인트는 스펙에 없음)."""
        assert self._client is not None
        params = {}
        if group:
            params["group"] = group
        if interface:
            params["interface"] = interface
        r = await self._client.get("/api/v1/tags", params=params)
        r.raise_for_status()
        return r.json()

    @staticmethod
    def _iso(dt: datetime) -> str:
        return dt.astimezone(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")

    async def read_raw(self, tag_ids, start, end):
        assert self._client is not None, "start() 미호출"
        out: dict[str, dict] = {}
        wanted = [t for t in tag_ids if t in self.numeric]
        for t in tag_ids:
            if t in self.resolve_errors:
                out[t] = {"t": [], "v": [], "error": self.resolve_errors[t]}
        if not wanted:
            return out
        r = await self._client.get("/api/v1/read/raw", params={
            "tagIds": ",".join(str(self.numeric[t]) for t in wanted),
            "start": self._iso(start),
            "end": self._iso(end),
        })
        r.raise_for_status()
        payload = r.json()
        # 스펙 형태: [{tagId, status, values:[{timestamp, value, quality}...]}] — 방어적으로 dict 형태도 수용
        items = payload
        if isinstance(payload, dict):
            items = payload.get("results") or payload.get("data") or payload
        if isinstance(items, dict):
            for rid, vals in items.items():
                out[self.rev.get(str(rid), str(rid))] = self._parse_values(vals)
        elif isinstance(items, list):
            for entry in items:
                rid = entry.get("tagId") if isinstance(entry, dict) else None
                if rid is None and isinstance(entry, dict):
                    rid = entry.get("tag") or entry.get("id")
                local = self.rev.get(str(rid), str(rid))
                series = self._parse_values(entry.get("values") or entry.get("data") or [])
                status = isinstance(entry, dict) and entry.get("status")
                if status and str(status).lower() not in ("success", "0"):
                    series["status"] = str(status)  # NoValues / UnknownOrInactiveTag 등 그대로 전달
                out[local] = series
        return out

    @staticmethod
    def _parse_values(vals) -> dict:
        t, v = [], []
        for p in vals or []:
            ts = p.get("timestamp") or p.get("time") or p.get("t")
            val = p.get("value", p.get("v"))
            if ts is None or val is None:
                continue
            if isinstance(ts, str):
                ts = datetime.fromisoformat(ts.replace("Z", "+00:00")).timestamp() * 1000
            elif ts < 1e12:  # 초 단위 epoch
                ts = ts * 1000
            try:
                v.append(float(val))
                t.append(int(ts))
            except (TypeError, ValueError):
                continue
        return {"t": t, "v": v}
