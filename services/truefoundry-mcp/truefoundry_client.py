"""Minimal async client for TrueFoundry control-plane APIs used by the demo tools."""

from __future__ import annotations

import json
import logging
import time
import uuid
from typing import Any

import httpx

from redaction import redact, truncate_text
from settings import Settings

logger = logging.getLogger("instrument_truefoundry_mcp.truefoundry_client")


class TrueFoundryAPIError(RuntimeError):
    """Raised when a TrueFoundry control-plane API call fails with safe detail."""


class TrueFoundryClient:
    def __init__(self, settings: Settings) -> None:
        self.settings = settings

    def _headers(self) -> dict[str, str]:
        missing = []
        if not self.settings.tfy_control_plane_url:
            missing.append("TFY_CONTROL_PLANE_URL")
        if not self.settings.tfy_api_token:
            missing.append("TFY_API_TOKEN")
        if missing:
            raise RuntimeError(f"missing required environment variables: {', '.join(missing)}")

        headers = {
            "Authorization": f"Bearer {self.settings.tfy_api_token}",
            "Content-Type": "application/json",
        }
        if self.settings.tfy_data_routing_destination:
            headers["x-tfy-data-routing-destination"] = self.settings.tfy_data_routing_destination
        return headers

    async def post(self, path: str, payload: dict[str, Any]) -> dict[str, Any]:
        request_id = uuid.uuid4().hex[:12]
        url = f"{self.settings.tfy_control_plane_url}{path}"
        redacted_payload = redact(payload, max_string_chars=300, max_items=25)
        logger.info(
            "truefoundry_request_start request_id=%s path=%s payload=%s",
            request_id,
            path,
            json.dumps(redacted_payload, sort_keys=True, default=str),
        )
        started = time.monotonic()
        async with httpx.AsyncClient(timeout=20.0) as client:
            try:
                response = await client.post(url, json=payload, headers=self._headers())
                elapsed_ms = int((time.monotonic() - started) * 1000)
                logger.info(
                    "truefoundry_request_complete request_id=%s path=%s status_code=%s elapsed_ms=%s",
                    request_id,
                    path,
                    response.status_code,
                    elapsed_ms,
                )
                response.raise_for_status()
                data = response.json()
                if isinstance(data, dict):
                    return data
                return {"result": data}
            except httpx.HTTPStatusError as exc:
                elapsed_ms = int((time.monotonic() - started) * 1000)
                response = exc.response
                body_snippet = truncate_text(response.text or "", 1000)
                logger.warning(
                    "truefoundry_request_failed request_id=%s path=%s status_code=%s elapsed_ms=%s response=%s",
                    request_id,
                    path,
                    response.status_code,
                    elapsed_ms,
                    body_snippet,
                )
                raise TrueFoundryAPIError(
                    f"TrueFoundry API request failed "
                    f"(request_id={request_id}, path={path}, status={response.status_code}, "
                    f"response={body_snippet or '[empty response]'})"
                ) from exc
            except httpx.RequestError as exc:
                elapsed_ms = int((time.monotonic() - started) * 1000)
                logger.warning(
                    "truefoundry_request_error request_id=%s path=%s elapsed_ms=%s error_type=%s error=%s",
                    request_id,
                    path,
                    elapsed_ms,
                    type(exc).__name__,
                    str(exc),
                )
                raise TrueFoundryAPIError(
                    f"TrueFoundry API request error "
                    f"(request_id={request_id}, path={path}, error_type={type(exc).__name__}, "
                    f"error={str(exc) or '[empty error]'})"
                ) from exc
            except ValueError as exc:
                elapsed_ms = int((time.monotonic() - started) * 1000)
                logger.warning(
                    "truefoundry_response_parse_failed request_id=%s path=%s elapsed_ms=%s error=%s",
                    request_id,
                    path,
                    elapsed_ms,
                    str(exc),
                )
                raise TrueFoundryAPIError(
                    f"TrueFoundry API response was not valid JSON "
                    f"(request_id={request_id}, path={path}, error={str(exc) or '[empty error]'})"
                ) from exc

    async def query_metrics(self, payload: dict[str, Any]) -> dict[str, Any]:
        return await self.post("/api/svc/v1/llm-gateway/metrics/query", payload)

    async def query_spans(self, payload: dict[str, Any]) -> dict[str, Any]:
        return await self.post("/api/svc/v1/spans/query", payload)
