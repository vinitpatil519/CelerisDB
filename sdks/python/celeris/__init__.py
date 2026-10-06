"""Python client for the Celeris distributed key-value / document database."""

from .client import (
    ChangeEvent,
    CelerisError,
    Client,
    Consistency,
    Item,
    OutcomeUnknownError,
    QueryPage,
    ScanPage,
    Watch,
    WriteResult,
    encode_key,
)

__all__ = [
    "ChangeEvent",
    "CelerisError",
    "Client",
    "Consistency",
    "Item",
    "OutcomeUnknownError",
    "QueryPage",
    "ScanPage",
    "Watch",
    "WriteResult",
    "encode_key",
]

__version__ = "0.1.0"
