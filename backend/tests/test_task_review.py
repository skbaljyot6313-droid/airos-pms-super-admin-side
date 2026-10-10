"""Task review workflow — approve / reject / review-queue.

Submitted tasks (employee app submit → PENDING_CHECK) are decided by
super_admin / property_manager: approve → completed + submission.approved,
reject → reopened + submission.disapproved; both notify the assignee via
the shared `notifications` table.
"""

import uuid
from datetime import datetime, timezone
from types import SimpleNamespace

import pytest

from app.models.task import Task, TaskCompletionSubmission
from app.models.user import UserRole
from app.services.structure import ConflictErr
from app.services.task import TaskService

CID = uuid.uuid4()
PID = uuid.uuid4()
EID = uuid.uuid4()
ZONE = uuid.uuid4()
ROOM = uuid.uuid4()

PROP = SimpleNamespace(id=PID, company_id=CID)

SA_USER = SimpleNamespace(
    id=uuid.uuid4(), role=UserRole.SUPER_ADMIN,
    company_id=CID, property_id=None, name="Admin",
)
PM_USER = SimpleNamespace(
    id=uuid.uuid4(), role=UserRole.PROPERTY_MANAGER,
    company_id=CID, property_id=PID, name="PM",
)
EMPLOYEE_USER = SimpleNamespace(
    id=uuid.uuid4(), role=UserRole.EMPLOYEE,
    company_id=CID, property_id=PID, name="Ram", employee_id=EID,
)


def _task(**kw) -> Task:
    base = dict(
        id=uuid.uuid4(), property_id=PID, title="Clean corridor",
        status="submitted", task_type="fixed", employee_id=EID,
        assigned_to_name="Ram", zone_id=ZONE, recurrence=None,
        submitted_at=datetime.now(timezone.utc),
        room_id=None, dorm_id=None, washroom_id=None,
        washroom_fixture_id=None, template_id=None,
    )
    base.update(kw)
    return Task(**base)


def _submission(task: Task, status="pending") -> TaskCompletionSubmission:
    s = TaskCompletionSubmission(
        id=uuid.uuid4(), task_id=task.id, status=status,
        employee_id=EID, employee_name="Ram", attempt_number=1,
        submitted_at=datetime.now(timezone.utc),
    )
    task.completion_submissions = [s]
    return s


class _Res:
    def __init__(self, rows):
        self.rows = list(rows) if isinstance(rows, (list, tuple)) else [rows]

    def scalar_one_or_none(self):
        return self.rows[0] if self.rows else None

    def scalar(self):
        return self.rows[0] if self.rows else None

    def scalars(self):
        return self

    def unique(self):
        return self

    def all(self):
        return self.rows

    def first(self):
        return self.rows[0] if self.rows else None

    def __iter__(self):
        return iter(self.rows)


class _Session:
    """Scripted session — execute() pops canned results in order."""
    def __init__(self, executes=(), get_obj=None):
        self._execs = list(executes)
        self._get = get_obj
        self.added = []

    async def execute(self, _q):
        rows = self._execs.pop(0) if self._execs else []
        return _Res(rows)

    async def get(self, _m, _id):
        return self._get

    async def scalar(self, _q):
        return None

    def add(self, o):
        self.added.append(o)

    async def flush(self):
        pass

    async def commit(self):
        pass

    async def delete(self, o):
        pass


def _svc(task, prop=PROP):
    """Session scripted for _get_task → task, then property."""
    return _Session(executes=[[task], [prop]])


# ---------------------------------------------------------------------------
# approve
# ---------------------------------------------------------------------------


@pytest.mark.anyio
class TestApprove:
    async def test_approve_marks_completed_and_submission_approved(self):
        task = _task()
        sub = _submission(task)
        sess = _svc(task)
        res = await TaskService(sess).approve_task(SA_USER, task.id, "good")
        t = res["task"]
        assert t.status == "completed" and t.completed_at is not None
        assert sub.status == "approved"
        assert sub.reviewed_by_name == "Admin"
        assert sub.review_comment == "good"
        kinds = [o.type for o in sess.added if hasattr(o, "type")]
        assert "approved" in kinds
        assert "submission_approved" in kinds

    async def test_approve_non_submitted_conflicts(self):
        task = _task(status="in_progress")
        with pytest.raises(ConflictErr):
            await TaskService(_svc(task)).approve_task(SA_USER, task.id)

    async def test_assignee_cannot_self_approve(self):
        task = _task()
        _submission(task)
        with pytest.raises(Exception) as ei:
            await TaskService(_svc(task)).approve_task(
                EMPLOYEE_USER, task.id
            )
        assert getattr(ei.value, "status_code", None) == 403

    async def test_pm_can_approve_room_task_in_own_property(
        self, monkeypatch
    ):
        """PM has SA's review authority inside his own property — the
        resource-refresh is stubbed since the scripted session holds no
        real room rows."""
        task = _task(room_id=ROOM)
        sub = _submission(task)

        async def _noop_refresh(self, task, user, trigger):
            return None

        monkeypatch.setattr(
            TaskService, "_refresh_unit", _noop_refresh
        )
        res = await TaskService(_svc(task)).approve_task(PM_USER, task.id)
        assert res["task"].status == "completed"
        assert sub.status == "approved"

    async def test_pm_cannot_review_foreign_property_task(self):
        """A task in a different property 404s at the scope check —
        _property_for_write rejects before review logic runs."""
        task = _task()
        _submission(task)
        foreign = SimpleNamespace(id=uuid.uuid4(), company_id=CID)
        sess = _Session(executes=[[task], [foreign]])
        with pytest.raises(Exception) as ei:
            await TaskService(sess).approve_task(PM_USER, task.id)
        assert getattr(ei.value, "status_code", None) == 404

    async def test_approve_no_submission_still_completes(self):
        task = _task()
        task.completion_submissions = []
        res = await TaskService(_svc(task)).approve_task(SA_USER, task.id)
        assert res["task"].status == "completed"


# ---------------------------------------------------------------------------
# reject
# ---------------------------------------------------------------------------


@pytest.mark.anyio
class TestReject:
    async def test_reject_reopens_and_marks_submission(self):
        task = _task()
        sub = _submission(task)
        sess = _svc(task)
        t = await TaskService(sess).reject_task(
            SA_USER, task.id, "photos blurry"
        )
        assert t.status == "reopened" and t.submitted_at is None
        assert sub.status == "disapproved"
        assert sub.review_comment == "photos blurry"
        assert sub.reviewed_by_name == "Admin"
        kinds = [o.type for o in sess.added if hasattr(o, "type")]
        assert "rejected" in kinds
        assert "submission_disapproved" in kinds

    async def test_reject_non_submitted_conflicts(self):
        task = _task(status="assigned")
        with pytest.raises(ConflictErr):
            await TaskService(_svc(task)).reject_task(
                SA_USER, task.id, "nope"
            )


# ---------------------------------------------------------------------------
# review queue
# ---------------------------------------------------------------------------


@pytest.mark.anyio
class TestReviewQueue:
    async def test_returns_property_scoped_submitted(self):
        t1, t2 = _task(), _task()
        sess = _Session(executes=[[PROP], [t1, t2]])
        items = await TaskService(sess).review_queue(SA_USER, PID)
        assert [t.id for t in items] == [t1.id, t2.id]

    async def test_wrong_property_raises(self):
        # _property_for_write: PM user.property_id must equal task property —
        # a PM asking for a different property's queue is rejected by the
        # structure-scope check itself (NotFound on mismatch happens only
        # when the property row doesn't match; here we hand the PM a prop
        # whose id differs from their scope).
        foreign = SimpleNamespace(id=uuid.uuid4(), company_id=CID)
        sess = _Session(executes=[[foreign]])
        with pytest.raises(Exception):
            await TaskService(sess).review_queue(PM_USER, foreign.id)
