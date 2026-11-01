"""Fetch and interpret arXiv papers for the tutor.

This is the only part of the agent service that touches the network. It calls
the public arXiv Atom API at ``https://export.arxiv.org/api/query`` with
``httpx`` and parses the response with :mod:`xml.etree.ElementTree` from the
standard library — deliberately no feedparser, no extra dependency.

Failure is treated as ordinary: no key, no account and no retry storm. Every
public function returns a dict, and on a timeout, a DNS failure, a bad status
or an empty result set it returns ``{"error": ...}`` with an actionable message
instead of raising, so a flaky network can never take down an agent turn.
"""

from __future__ import annotations

import re
import xml.etree.ElementTree as ET
from typing import Any
from urllib.parse import urlencode

from agent import curriculum

__all__ = [
    "ARXIV_API_URL",
    "USER_AGENT",
    "REQUEST_TIMEOUT",
    "MAX_RESPONSE_BYTES",
    "fetch_paper",
    "extract_quantum_context",
]

#: The public arXiv Atom API endpoint.
ARXIV_API_URL: str = "https://export.arxiv.org/api/query"

# arXiv's API usage guidance asks callers to identify themselves and to keep
# request rates low (roughly one request every few seconds, and no hammering
# after an error). This module honours that by design: exactly ONE HTTP request
# per fetch_paper() call, no retry loop anywhere, and a descriptive User-Agent
# carrying a contact URL so arXiv can reach the operator if this misbehaves.
USER_AGENT: str = "QuantumLabTutor/1.0 (+https://github.com/quantum-lab; educational agent)"

#: Seconds before the single request is abandoned.
REQUEST_TIMEOUT: float = 15.0

#: Hard cap on the response bytes read. One paper's Atom entry is a few KB; the
#: body lands in memory and is parsed as XML inside a 0.5 GiB container, so an
#: oversized or redirected response is refused while it streams, not after.
#: Same value as agent.paper.MAX_RESPONSE_BYTES.
MAX_RESPONSE_BYTES: int = 512 * 1024

_ATOM = "{http://www.w3.org/2005/Atom}"
_ARXIV_NS = "{http://arxiv.org/schemas/atom}"

#: ``2401.12345``, ``2401.12345v2``, and the old ``quant-ph/0201082`` style.
_NEW_ID_RE = re.compile(r"\b(\d{4}\.\d{4,5}(?:v\d+)?)\b")
_OLD_ID_RE = re.compile(r"\b([a-z-]+(?:\.[A-Z]{2})?/\d{7}(?:v\d+)?)\b")


def _identifier_kind(identifier: str) -> tuple[str, str]:
    """Classify a user-supplied paper reference.

    Accepts a bare arXiv id, an ``arxiv.org/abs/...`` or ``.../pdf/...`` URL, or
    free text that should be treated as a title search.

    Args:
        identifier: Whatever the learner or the model supplied.

    Returns:
        A tuple of (kind, value) where kind is ``"id"`` or ``"query"``.
    """
    text = (identifier or "").strip()
    if not text:
        return "query", ""

    # A URL is just an id with decoration; strip it down.
    candidate = text
    if "arxiv.org" in text.lower():
        candidate = text.rstrip("/").rsplit("/", 1)[-1]
        if candidate.lower().endswith(".pdf"):
            candidate = candidate[:-4]

    match = _NEW_ID_RE.search(candidate) or _OLD_ID_RE.search(candidate)
    if match and len(candidate.split()) == 1:
        return "id", match.group(1)

    match = _NEW_ID_RE.fullmatch(text) or _OLD_ID_RE.fullmatch(text)
    if match:
        return "id", match.group(1)

    return "query", text


def _text(node: Any) -> str:
    """Collapse an XML node's text to a single clean line-wrapped string.

    Args:
        node: An ``Element`` or ``None``.

    Returns:
        The whitespace-normalised text, or ``""``.
    """
    if node is None or node.text is None:
        return ""
    return " ".join(node.text.split())


def _parse_entry(entry: ET.Element) -> dict[str, Any]:
    """Convert one Atom ``<entry>`` into the tool's paper dict.

    Args:
        entry: The ``<entry>`` element from an arXiv API response.

    Returns:
        A dict with ``id``, ``title``, ``authors``, ``published``, ``summary``,
        ``categories``, ``url`` and ``pdf_url``.
    """
    raw_id = _text(entry.find(f"{_ATOM}id"))
    paper_id = raw_id.rsplit("/abs/", 1)[-1] if "/abs/" in raw_id else raw_id

    authors = [
        _text(name)
        for name in entry.findall(f"{_ATOM}author/{_ATOM}name")
        if _text(name)
    ]

    categories = [
        term
        for term in (
            cat.get("term") for cat in entry.findall(f"{_ATOM}category")
        )
        if term
    ]
    primary = entry.find(f"{_ARXIV_NS}primary_category")
    if primary is not None and primary.get("term") and primary.get("term") not in categories:
        categories.insert(0, primary.get("term", ""))

    url = raw_id
    pdf_url = ""
    for link in entry.findall(f"{_ATOM}link"):
        href = link.get("href", "")
        if link.get("title") == "pdf" or link.get("type") == "application/pdf":
            pdf_url = href
        elif link.get("rel") == "alternate" and href:
            url = href
    if not pdf_url and paper_id:
        pdf_url = f"https://arxiv.org/pdf/{paper_id}"

    return {
        "id": paper_id,
        "title": _text(entry.find(f"{_ATOM}title")),
        "authors": authors,
        "published": _text(entry.find(f"{_ATOM}published")),
        "summary": _text(entry.find(f"{_ATOM}summary")),
        "categories": categories,
        "url": url,
        "pdf_url": pdf_url,
    }


def fetch_paper(identifier: str) -> dict[str, Any]:
    """Fetch one paper's metadata and abstract from arXiv.

    Makes exactly one HTTP request. An arXiv id (with or without a version
    suffix) or an ``abs``/``pdf`` URL is looked up by id; anything else is
    treated as a title-ish search and the single best match is returned.

    Args:
        identifier: ``"2401.12345"``, ``"https://arxiv.org/abs/2401.12345"``,
            ``"quant-ph/0201082"``, or a free-text title such as
            ``"surface code thresholds"``.

    Returns:
        A dict with ``id``, ``title``, ``authors``, ``published``, ``summary``,
        ``categories``, ``url`` and ``pdf_url``. On a network failure, timeout,
        malformed response or no match, a dict with a single ``error`` key
        carrying an actionable message. This function never raises.
    """
    kind, value = _identifier_kind(identifier)
    if not value:
        return {
            "error": (
                "No paper identifier was provided. Pass an arXiv id like "
                "'2401.12345', an arxiv.org URL, or a paper title to search for."
            )
        }

    if kind == "id":
        params = {"id_list": value, "max_results": "1"}
    else:
        # Quote the phrase so the search stays tight rather than OR-ing words.
        params = {"search_query": f'all:"{value}"', "max_results": "1", "start": "0"}

    url = f"{ARXIV_API_URL}?{urlencode(params)}"

    try:
        import httpx

        # One request, no retry loop — see the arXiv rate guidance note above.
        # Streamed so the byte cap applies before the body is buffered.
        chunks: list[bytes] = []
        received = 0
        with httpx.stream(
            "GET",
            url,
            timeout=REQUEST_TIMEOUT,
            headers={"User-Agent": USER_AGENT},
            follow_redirects=True,
        ) as response:
            response.raise_for_status()
            for chunk in response.iter_bytes():
                received += len(chunk)
                if received > MAX_RESPONSE_BYTES:
                    return {
                        "error": (
                            f"The arXiv response is over the {MAX_RESPONSE_BYTES} byte cap "
                            "for a single-paper metadata query, so it was not read. Try "
                            "again later or with a different identifier."
                        )
                    }
                chunks.append(chunk)
        body = b"".join(chunks).decode("utf-8", errors="replace")
    except Exception as exc:  # noqa: BLE001 - report, never raise, to the model
        return {
            "error": (
                f"Could not reach the arXiv API ({type(exc).__name__}: {exc}). "
                "Tell the learner the lookup failed and answer from the course "
                "material instead; do not invent the paper's contents."
            )
        }

    try:
        root = ET.fromstring(body)
    except ET.ParseError as exc:
        return {
            "error": (
                f"arXiv returned a response that is not valid Atom XML ({exc}). "
                "Try again later or with a different identifier."
            )
        }

    entries = root.findall(f"{_ATOM}entry")
    for entry in entries:
        paper = _parse_entry(entry)
        # A miss on id_list can come back as a stub entry with no title.
        if paper["title"] and "Error" not in paper["title"]:
            return paper

    return {
        "error": (
            f"No arXiv paper matched {identifier!r}. Check the id, or search with "
            "a few distinctive words from the title instead of the full sentence."
        )
    }


#: Concepts scanned for in an abstract, mapped to the phrases that signal them.
#: The vocabulary is the course's own (see ``curriculum.CONCEPT_DEPENDENCIES``),
#: so every hit can be traced back to a lesson the learner can actually read.
_CONCEPT_MARKERS: dict[str, tuple[str, ...]] = {
    "qubit": ("qubit", "two-level system"),
    "superposition": ("superposition", "coherent state"),
    "measurement": ("measurement", "readout", "born rule", "projective"),
    "interference": ("interference", "constructive", "destructive"),
    "phase": ("phase", "phase estimation", "relative phase"),
    "gates": ("gate", "circuit", "unitary", "transpil"),
    "bloch sphere": ("bloch sphere", "bloch vector"),
    "entanglement": ("entangl", "bell state", "bell inequality", "ghz"),
    "no cloning": ("no-cloning", "no cloning"),
    "grover": ("grover", "amplitude amplification", "unstructured search"),
    "qft": ("fourier transform", "qft"),
    "period finding": ("period finding", "order finding"),
    "shor": ("shor", "factoring", "factorization", "factorisation"),
    "decoherence": ("decoherence", "dephasing", "relaxation", "t1", "t2", "noise"),
    "error correction": (
        "error correction",
        "error-correct",
        "surface code",
        "stabilizer",
        "stabiliser",
        "fault toleran",
        "syndrome",
        "logical qubit",
    ),
    "nisq": ("nisq", "near-term"),
    "vqe": ("variational", "vqe", "qaoa", "ansatz"),
    "cryptography": ("cryptograph", "key distribution", "bb84", "qkd"),
    "tunneling": ("tunneling", "tunnelling", "josephson"),
}

#: Terms that mark a paper as research-level rather than survey-level.
_ADVANCED_MARKERS: tuple[str, ...] = (
    "fault toleran",
    "surface code",
    "stabilizer",
    "stabiliser",
    "threshold theorem",
    "lattice surgery",
    "magic state",
    "hamiltonian simulation",
    "asymptotic",
    "we prove",
    "lower bound",
    "complexity class",
    "qma",
    "bqp",
)


def extract_quantum_context(paper: dict[str, Any]) -> dict[str, Any]:
    """Map a fetched paper onto the concepts and lessons this course teaches.

    Scans the title and abstract for the course's own concept vocabulary so the
    tutor can say something concretely useful — "this leans on the
    error-correction lesson, read that first" — instead of paraphrasing the
    abstract back at the learner.

    Args:
        paper: A dict as returned by :func:`fetch_paper`. An error dict, or one
            with no abstract, is handled gracefully.

    Returns:
        A dict with ``concepts`` (course concept names found, most prominent
        first), ``related_lessons`` (lesson slugs in course order) and
        ``difficulty`` (``"intermediate"`` or ``"advanced"``).
    """
    if not isinstance(paper, dict) or "error" in paper:
        return {"concepts": [], "related_lessons": [], "difficulty": "intermediate"}

    text = f"{paper.get('title', '')} {paper.get('summary', '')}".lower()
    if not text.strip():
        return {"concepts": [], "related_lessons": [], "difficulty": "intermediate"}

    hits: dict[str, int] = {}
    for concept, markers in _CONCEPT_MARKERS.items():
        count = sum(text.count(marker) for marker in markers)
        if count:
            hits[concept] = count

    concepts = sorted(hits, key=lambda c: (-hits[c], c))

    lesson_slugs: set[str] = set()
    for concept in concepts:
        slug = curriculum.lesson_for_concept(concept)
        if slug:
            lesson_slugs.add(slug)
    related = [slug for slug in curriculum.LESSON_SLUGS if slug in lesson_slugs]

    advanced_hits = sum(1 for marker in _ADVANCED_MARKERS if marker in text)
    deep_lessons = any(
        (curriculum.get_lesson(slug) or {}).get("level") == "Advanced" for slug in related
    )
    categories = [str(c).lower() for c in paper.get("categories", []) or []]
    theory_category = any(c.startswith(("cs.cc", "math-ph", "quant-ph")) for c in categories)

    difficulty = (
        "advanced"
        if advanced_hits >= 1 or (deep_lessons and theory_category and len(concepts) >= 4)
        else "intermediate"
    )

    return {
        "concepts": concepts,
        "related_lessons": related,
        "difficulty": difficulty,
    }
