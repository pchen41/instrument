"""Small redaction helpers for provider responses."""

from __future__ import annotations

from collections.abc import Mapping
from typing import Any


SENSITIVE_KEY_PARTS = (
    "authorization",
    "api_key",
    "apikey",
    "access_token",
    "refresh_token",
    "bearer",
    "credential",
    "password",
    "secret",
    "token",
)

PROMPT_KEY_PARTS = (
    "messages",
    "prompt",
    "system_prompt",
    "input",
    "output",
    "completion",
)


def truncate_text(value: str, max_chars: int = 500) -> str:
    if len(value) <= max_chars:
        return value
    return f"{value[:max_chars]}...[truncated {len(value) - max_chars} chars]"


def redact(value: Any, *, max_string_chars: int = 500, max_items: int = 50) -> Any:
    if isinstance(value, Mapping):
        redacted: dict[str, Any] = {}
        for key, item in value.items():
            normalized = str(key).lower()
            if any(part in normalized for part in SENSITIVE_KEY_PARTS):
                redacted[str(key)] = "[redacted]"
            elif any(part in normalized for part in PROMPT_KEY_PARTS):
                redacted[str(key)] = "[redacted]"
            else:
                redacted[str(key)] = redact(
                    item,
                    max_string_chars=max_string_chars,
                    max_items=max_items,
                )
        return redacted

    if isinstance(value, list):
        limited = value[:max_items]
        result = [
            redact(item, max_string_chars=max_string_chars, max_items=max_items)
            for item in limited
        ]
        if len(value) > max_items:
            result.append({"truncated_items": len(value) - max_items})
        return result

    if isinstance(value, tuple):
        return tuple(redact(list(value), max_string_chars=max_string_chars, max_items=max_items))

    if isinstance(value, str):
        return truncate_text(value, max_string_chars)

    return value
