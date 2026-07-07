"""dataPARC.Store REST API 커넥터 (신형 dataPARC — 1순위 권장).

검증된 엔드포인트 (github.com/dataPARC/store 의 OpenAPI 스펙 기준):
  GET {base}/api/v1/read/raw?tagIds=...&start=...&end=...
  GET {base}/api/v1/read/current?tagIds=...
  GET {base}/auth-info            ← 보안(OAuth) 활성 여부 확인

- HTTPS 전용 (HTTP 미지원).
- 보안 활성 서버는 Authorization: Bearer 토큰 필요 (config의 bearer_token).
- 응답 스키마는 사이트/버전에 따라 다를 수 있어 방어적으로 파싱한다.
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
        # 웹앱 태그ID → dataPARC 태그 식별자
        self.tagmap: dict[str, str] = cfg.get("tags", {}) or {}
        self.rev = {v: k for k, v in self.tagmap.items()}
        self._client: httpx.AsyncClient | None = None

    async def start(self) -> None:
        headers = {"Accept": "application/json"}
        if self.token:
            headers["Authorization"] = f"Bearer {self.token}"
        self._client = httpx.AsyncClient(base_url=self.base, verify=self.verify,
                                         headers=headers, timeout=30.0)

    async def stop(self) -> None:
        if self._client:
            await self._client.aclose()

    async def list_tags(self) -> list[dict]:
        return [{"id": k, "desc": v, "unit": ""} for k, v in self.tagmap.items()]

    @staticmethod
    def _iso(dt: datetime) -> str:
        return dt.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")

    async def read_raw(self, tag_ids, start, end):
        assert self._client is not None, "start() 미호출"
        out: dict[str, dict] = {}
        remote_ids = [self.tagmap.get(t, t) for t in tag_ids]
        r = await self._client.get("/api/v1/read/raw", params={
            "tagIds": ",".join(remote_ids),
            "start": self._iso(start),
            "end": self._iso(end),
        })
        r.raise_for_status()
        payload = r.json()
        # 방어적 파싱: {tagId: [{timestamp, value}...]} 또는 [{tagId, values:[...]}] 등
        items = payload
        if isinstance(payload, dict):
            items = payload.get("results") or payload.get("data") or payload
        if isinstance(items, dict):
            for rid, vals in items.items():
                out[self.rev.get(rid, rid)] = self._parse_values(vals)
        elif isinstance(items, list):
            for entry in items:
                rid = entry.get("tagId") or entry.get("tag") or entry.get("id")
                vals = entry.get("values") or entry.get("data") or []
                out[self.rev.get(str(rid), str(rid))] = self._parse_values(vals)
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
