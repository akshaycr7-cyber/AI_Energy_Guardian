"""Lazy, environment-based Firebase Admin and Firestore configuration."""
from __future__ import annotations

import os
from typing import Any

import firebase_admin
from firebase_admin import credentials, firestore

from backend.config import load_project_environment

load_project_environment()


def get_firestore_client() -> Any:
    """Return the Firestore client, initializing Firebase from environment once.

    Credentials are deliberately read only when Firestore is used, so local API
    validation and unit tests do not require a Firebase project.
    """
    if not firebase_admin._apps:
        project_id = os.getenv("FIREBASE_PROJECT_ID")
        client_email = os.getenv("FIREBASE_CLIENT_EMAIL")
        private_key = os.getenv("FIREBASE_PRIVATE_KEY")
        if not all((project_id, client_email, private_key)):
            raise RuntimeError(
                "Firebase is not configured. Set FIREBASE_PROJECT_ID, "
                "FIREBASE_CLIENT_EMAIL, and FIREBASE_PRIVATE_KEY."
            )
        credential_data = {
            "type": "service_account",
            "project_id": project_id,
            "client_email": client_email,
            "private_key": private_key.replace("\\n", "\n"),
            "token_uri": "https://oauth2.googleapis.com/token",
        }
        firebase_admin.initialize_app(credentials.Certificate(credential_data))
    return firestore.client()
