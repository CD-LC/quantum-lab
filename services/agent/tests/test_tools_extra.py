"""Tests for the learner, quiz, arXiv and recommendation tools.

Like ``test_tools.py``, everything here runs offline: no Anthropic API key, no
LangChain, and no network — the one tool that would use the network has its HTTP
call monkeypatched or pointed at a dead port.

The final test in this file is a drift test: the Python course mirror in
``agent/curriculum.py`` duplicates data that really lives in TypeScript, so the
test reads the TypeScript sources directly and fails if a mirrored slug has
disappeared.
"""

from __future__ import annotations

import re
from pathlib import Path

import pytest

from agent import arxiv, curriculum, learner
from agent.tools import (
    _create_quiz_impl,
    _fetch_arxiv_paper_impl,
    _get_learner_profile_impl,
    _recommend_next_lesson_impl,
)

#: services/agent/tests -> repo root.
REPO_ROOT = Path(__file__).resolve().parents[3]
LESSONS_DIR = REPO_ROOT / "apps" / "web" / "lib" / "lessons"

#: A plausible mid-course payload, shaped exactly like the browser's
#: ``quantum-lab.progress`` object.
REALISTIC_PROGRESS: dict[str, object] = {
    "completed": [
        "what-is-a-qubit",
        "superposition-and-measurement",
        "interference",
        "gates-and-circuits",
    ],
    "quizScores": {
        "what-is-a-qubit": 1.0,
        "superposition-and-measurement": 0.85,
        "interference": 0.9,
        "gates-and-circuits": 0.8,
    },
    "lastVisited": "gates-and-circuits",
}


# --------------------------------------------------------------------------- #
# get_learner_profile / parse_progress
# --------------------------------------------------------------------------- #


def test_profile_none_is_not_an_error() -> None:
    """A signed-out learner gets a clearly marked 'no profile' result."""
    result = _get_learner_profile_impl(None)

    assert "error" not in result
    assert result["available"] is False
    assert result["completed"] == []
    assert result["level"] == "beginner"
    assert "no profile" in result["summary"].lower()
    assert "what-is-a-qubit" in result["unlocked"]


def test_profile_realistic_payload_infers_level() -> None:
    """Four completed lessons with strong quizzes read as intermediate."""
    result = _get_learner_profile_impl(REALISTIC_PROGRESS)

    assert result["available"] is True
    assert result["level"] == "intermediate"
    assert result["completed"] == [
        "what-is-a-qubit",
        "superposition-and-measurement",
        "interference",
        "gates-and-circuits",
    ]
    assert result["last_visited"] == "gates-and-circuits"
    assert "entanglement" in result["unlocked"]
    assert result["summary"].strip()


def test_profile_advanced_payload() -> None:
    """A learner through the advanced lessons with high scores reads advanced."""
    payload = {
        "completed": [
            "what-is-a-qubit",
            "superposition-and-measurement",
            "interference",
            "gates-and-circuits",
            "entanglement",
            "grover",
            "shor",
        ],
        "quizScores": {"grover": 0.9, "shor": 0.95, "entanglement": 0.85},
    }
    assert _get_learner_profile_impl(payload)["level"] == "advanced"


def test_parse_progress_survives_garbage() -> None:
    """A hand-edited, wrongly typed payload degrades instead of raising."""
    garbage = {
        "completed": ["what-is-a-qubit", 42, None, {"nope": 1}, "not-a-real-lesson"],
        "quizScores": {"interference": "high", "grover": None, 7: 0.5, "shor": 88},
        "lastVisited": None,
        "circuitsSaved": "many",
        "examAttempts": "definitely not a list",
        "unexpectedKey": object(),
    }

    profile = learner.parse_progress(garbage)

    assert profile.completed == ["what-is-a-qubit"]
    assert "interference" not in profile.quiz_scores
    assert "grover" not in profile.quiz_scores
    assert profile.quiz_scores["shor"] == pytest.approx(0.88)  # 88 read as a percentage
    assert profile.last_visited is None
    assert profile.circuits_saved == 0
    assert profile.exam_best == {}
    assert profile.level in {"beginner", "intermediate", "advanced"}


@pytest.mark.parametrize("payload", [None, {}, [], "nope", 3, {"completed": None}])
def test_parse_progress_never_raises(payload: object) -> None:
    """Every shape of nonsense yields a usable profile."""
    profile = learner.parse_progress(payload)  # type: ignore[arg-type]
    assert isinstance(profile, learner.LearnerProfile)
    assert learner.summarise(profile).strip()


# --------------------------------------------------------------------------- #
# weak_concepts
# --------------------------------------------------------------------------- #


def test_weak_concepts_surfaces_low_quiz_score() -> None:
    """A lesson scored at 0.4 is flagged as weak."""
    profile = learner.parse_progress(
        {
            "completed": ["what-is-a-qubit", "superposition-and-measurement"],
            "quizScores": {"what-is-a-qubit": 0.95, "superposition-and-measurement": 0.4},
        }
    )

    weak = learner.weak_concepts(profile)
    assert "superposition-and-measurement" in weak
    assert "what-is-a-qubit" not in weak


def test_weak_concepts_surfaces_ready_but_unstarted() -> None:
    """A lesson whose prerequisites are all done but which was never started."""
    profile = learner.parse_progress(
        {
            "completed": ["what-is-a-qubit"],
            "quizScores": {"what-is-a-qubit": 0.95},
        }
    )

    weak = learner.weak_concepts(profile)
    # superposition-and-measurement is unlocked (its only prereq is complete)
    # and has no score of its own — the "ready but avoided" signal.
    assert "superposition-and-measurement" in weak
    assert "grover" not in weak  # still locked, so not actionable


def test_weak_concepts_orders_by_blocking() -> None:
    """The lesson that blocks the most of the course comes first."""
    profile = learner.parse_progress(
        {
            "completed": ["what-is-a-qubit", "superposition-and-measurement", "interference"],
            "quizScores": {
                "superposition-and-measurement": 0.4,
                "interference": 0.5,
            },
        }
    )

    weak = learner.weak_concepts(profile)
    assert weak[0] == "superposition-and-measurement"


# --------------------------------------------------------------------------- #
# create_quiz
# --------------------------------------------------------------------------- #


def test_create_quiz_returns_full_questions() -> None:
    """Questions come back with options, a valid answer and an explanation."""
    result = _create_quiz_impl("entanglement", level="intermediate", n=3)

    assert "error" not in result
    assert result["concept"] == "entanglement"
    assert len(result["questions"]) == 3
    for question in result["questions"]:
        assert question["prompt"].strip()
        assert len(question["options"]) >= 3
        ids = [opt["id"] for opt in question["options"]]
        assert len(set(ids)) == len(ids)
        assert question["answer"] in ids
        assert len(question["explanation"]) > 40


@pytest.mark.parametrize("slug", sorted(curriculum.LESSON_SLUGS))
def test_create_quiz_covers_every_lesson(slug: str) -> None:
    """Every one of the ten lessons has at least three real questions."""
    result = _create_quiz_impl(slug, n=3)
    assert "error" not in result, result
    assert len(result["questions"]) == 3


def test_create_quiz_accepts_synonyms() -> None:
    """A loose topic name still resolves to the right bank."""
    assert _create_quiz_impl("bell states")["concept"] == "entanglement"
    assert _create_quiz_impl("qkd")["concept"] == "quantum-cryptography"


def test_create_quiz_unknown_concept_lists_alternatives() -> None:
    """An unknown topic returns an error plus the concepts that do exist."""
    result = _create_quiz_impl("purple wednesday sandwiches")

    assert "error" in result
    assert "available_concepts" in result
    assert "entanglement" in result["available_concepts"]
    assert len(result["available_concepts"]) == len(curriculum.LESSON_SLUGS)


# --------------------------------------------------------------------------- #
# recommend_next_lesson
# --------------------------------------------------------------------------- #


def test_recommend_empty_progress_starts_at_the_beginning() -> None:
    """With nothing done, the first foundations lesson is the answer."""
    result = _recommend_next_lesson_impl(None)

    assert result["recommendation"] == "what-is-a-qubit"
    assert result["title"]
    assert result["why"].strip()


def test_recommend_with_goal_returns_an_earlier_prerequisite() -> None:
    """Asking for Shor from a standing start yields a much earlier lesson."""
    result = _recommend_next_lesson_impl(
        {"completed": ["what-is-a-qubit"], "quizScores": {"what-is-a-qubit": 0.9}},
        goal="I want to understand Shor's algorithm",
    )

    assert result["recommendation"] != "shor"
    assert result["recommendation"] == "superposition-and-measurement"
    assert "shor" in result["path"]
    assert result["path"].index(result["recommendation"]) < result["path"].index("shor")


def test_recommend_with_goal_when_chain_is_complete() -> None:
    """With every prerequisite done, the goal itself is the recommendation."""
    result = _recommend_next_lesson_impl(
        {
            "completed": [
                "what-is-a-qubit",
                "superposition-and-measurement",
                "interference",
                "gates-and-circuits",
                "entanglement",
                "grover",
            ]
        },
        goal="shor",
    )

    assert result["recommendation"] == "shor"


def test_recommend_prefers_revision_over_advancing() -> None:
    """A weak quiz score beats moving on to the next unlocked lesson."""
    result = _recommend_next_lesson_impl(
        {
            "completed": [
                "what-is-a-qubit",
                "superposition-and-measurement",
                "interference",
            ],
            "quizScores": {
                "what-is-a-qubit": 0.95,
                "superposition-and-measurement": 0.4,
                "interference": 0.9,
            },
        }
    )

    assert result["recommendation"] == "superposition-and-measurement"
    assert "gates-and-circuits" != result["recommendation"]
    assert "40%" in result["why"]


# --------------------------------------------------------------------------- #
# fetch_arxiv_paper (no network)
# --------------------------------------------------------------------------- #


class _FakeStream:
    """A stand-in for the ``httpx.stream`` context manager."""

    def __init__(self, chunks: list[bytes]) -> None:
        self._chunks = chunks
        self.chunks_read = 0

    def __enter__(self) -> "_FakeStream":
        return self

    def __exit__(self, *_exc: object) -> None:
        return None

    def raise_for_status(self) -> None:
        return None

    def iter_bytes(self):  # type: ignore[no-untyped-def]
        for chunk in self._chunks:
            self.chunks_read += 1
            yield chunk


def test_fetch_arxiv_uses_https_everywhere() -> None:
    """The API endpoint and the fallback PDF link are not cleartext."""
    assert arxiv.ARXIV_API_URL.startswith("https://")
    entry = arxiv.ET.fromstring(
        '<entry xmlns="http://www.w3.org/2005/Atom"><id>http://arxiv.org/abs/2401.00001v1</id>'
        "<title>T</title></entry>"
    )
    assert arxiv._parse_entry(entry)["pdf_url"].startswith("https://arxiv.org/pdf/")


def test_fetch_arxiv_caps_the_response_while_streaming(monkeypatch: pytest.MonkeyPatch) -> None:
    """An oversized body is refused before the rest of it is read."""
    import httpx

    big = [b"x" * 100_000 for _ in range(50)]
    stream = _FakeStream(big)
    monkeypatch.setattr(httpx, "stream", lambda *a, **k: stream)

    result = arxiv.fetch_paper("2401.12345")

    assert "error" in result and "cap" in result["error"]
    # 512 KiB cap / 100 kB chunks: stopped after 6 chunks, not 50.
    assert stream.chunks_read <= 6


def test_fetch_arxiv_unreachable_host_returns_error(monkeypatch: pytest.MonkeyPatch) -> None:
    """A dead endpoint yields {error}, never an exception."""
    monkeypatch.setattr(arxiv, "ARXIV_API_URL", "http://127.0.0.1:9/api/query")
    monkeypatch.setattr(arxiv, "REQUEST_TIMEOUT", 2.0)

    result = _fetch_arxiv_paper_impl("2401.12345")

    assert "error" in result
    assert "arxiv" in result["error"].lower()
    assert "title" not in result


def test_fetch_arxiv_transport_failure_is_caught(monkeypatch: pytest.MonkeyPatch) -> None:
    """Any httpx exception is reported rather than propagated."""
    import httpx

    def boom(*_args: object, **_kwargs: object) -> None:
        raise httpx.ConnectTimeout("simulated timeout")

    monkeypatch.setattr(httpx, "stream", boom)

    result = arxiv.fetch_paper("https://arxiv.org/abs/2401.12345")
    assert "error" in result
    assert "ConnectTimeout" in result["error"]


def test_fetch_arxiv_empty_identifier() -> None:
    """An empty identifier is rejected without any network call."""
    result = _fetch_arxiv_paper_impl("   ")
    assert "error" in result
    assert "identifier" in result["error"].lower()


def test_fetch_arxiv_parses_a_canned_response(monkeypatch: pytest.MonkeyPatch) -> None:
    """A recorded Atom response is parsed into the documented shape."""
    import httpx

    atom = """<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <entry>
    <id>http://arxiv.org/abs/1234.56789v1</id>
    <published>2020-01-02T00:00:00Z</published>
    <title>Surface code thresholds under realistic noise</title>
    <summary>We study fault tolerance of the surface code, measuring stabilizer
      syndromes on entangled logical qubits subject to decoherence.</summary>
    <author><name>A Researcher</name></author>
    <author><name>B Researcher</name></author>
    <link href="http://arxiv.org/abs/1234.56789v1" rel="alternate" type="text/html"/>
    <link title="pdf" href="http://arxiv.org/pdf/1234.56789v1" rel="related"/>
    <category term="quant-ph"/>
  </entry>
</feed>"""

    captured: dict[str, object] = {}

    def fake_stream(method: str, url: str, **kwargs: object) -> _FakeStream:
        captured["url"] = url
        captured["headers"] = kwargs.get("headers")
        return _FakeStream([atom.encode("utf-8")])

    monkeypatch.setattr(httpx, "stream", fake_stream)

    result = _fetch_arxiv_paper_impl("1234.56789")

    assert "error" not in result
    assert result["id"] == "1234.56789v1"
    assert result["title"].startswith("Surface code thresholds")
    assert result["authors"] == ["A Researcher", "B Researcher"]
    assert result["categories"] == ["quant-ph"]
    assert result["pdf_url"].endswith(".56789v1")
    assert "error correction" in result["concepts"]
    assert "error-correction" in result["related_lessons"]
    assert result["difficulty"] == "advanced"

    # arXiv rate guidance: exactly one request, identified by User-Agent.
    assert "id_list=1234.56789" in str(captured["url"])
    headers = captured["headers"]
    assert isinstance(headers, dict) and "QuantumLab" in headers["User-Agent"]


# --------------------------------------------------------------------------- #
# Drift: the Python mirror must match the TypeScript course definition
# --------------------------------------------------------------------------- #


def test_curriculum_mirror_has_not_drifted() -> None:
    """Every slug in curriculum.LESSONS still exists in the TypeScript course."""
    # Read every non-test lesson module rather than a hardcoded pair of names.
    # The course was originally two files (index.ts, advanced.ts); the body/
    # metadata split moved the prose into lib/lessons/bodies/*.ts and deleted
    # advanced.ts, which turned this drift check into a FileNotFoundError —
    # a green-to-red that said nothing about drift. Globbing means a future
    # reshuffle of the lesson modules cannot break it again; the assert below
    # still fails loudly if the glob finds nothing.
    sources = "\n".join(
        path.read_text(encoding="utf-8")
        for path in sorted(LESSONS_DIR.rglob("*.ts"))
        if not path.name.endswith(".test.ts")
    )

    assert sources.strip(), f"Could not read lesson sources from {LESSONS_DIR}"

    missing = [
        lesson["slug"]
        for lesson in curriculum.LESSONS
        if f"slug: '{lesson['slug']}'" not in sources
        and f'slug: "{lesson["slug"]}"' not in sources
    ]
    assert not missing, (
        f"curriculum.py lists slugs that no longer exist in the TypeScript course: "
        f"{missing}. Update the Python mirror in agent/curriculum.py."
    )

    # And the mirror must not be missing lessons the TypeScript side has added.
    #
    # Count DISTINCT slugs, not occurrences. Since the body/metadata split each
    # slug appears twice — once in index.ts's LessonMeta list and once in the
    # matching lib/lessons/bodies/*.ts entry — so the old
    # `sources.count("    slug: '")` reported 21 lessons for an 11-lesson
    # course. Whether the slug appears once or five times is not the fact under
    # test; which slugs exist is.
    ts_slugs = set(re.findall(r"slug:\s*['\"]([a-z0-9-]+)['\"]", sources))
    mirror_slugs = {lesson["slug"] for lesson in curriculum.LESSONS}
    assert ts_slugs == mirror_slugs, (
        "The Python mirror in agent/curriculum.py has drifted from the "
        "TypeScript course.\n"
        f"  in the course but not the mirror: {sorted(ts_slugs - mirror_slugs)}\n"
        f"  in the mirror but not the course: {sorted(mirror_slugs - ts_slugs)}"
    )


def test_curriculum_prerequisites_are_internally_consistent() -> None:
    """Every prerequisite names a real lesson that comes earlier in the order."""
    order = {slug: i for i, slug in enumerate(curriculum.LESSON_SLUGS)}
    for lesson in curriculum.LESSONS:
        for prereq in lesson["prerequisites"]:
            assert prereq in order, f"{lesson['slug']} requires unknown lesson {prereq}"
            assert order[prereq] < order[lesson["slug"]], (
                f"{lesson['slug']} requires {prereq}, which comes later in the course"
            )


def test_visualization_slugs_exist_on_disk() -> None:
    """Each mirrored visualization has a matching Next.js route directory."""
    viz_dir = REPO_ROOT / "apps" / "web" / "app" / "visualizations"
    for viz in curriculum.VISUALIZATIONS:
        assert (viz_dir / viz["slug"]).is_dir(), f"missing route for {viz['slug']}"
