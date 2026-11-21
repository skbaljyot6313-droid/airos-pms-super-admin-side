"""Department management payloads — create/update/transfer/head ops."""
import uuid
from datetime import datetime
from typing import Literal

from pydantic import BaseModel, Field


class DepartmentCreateRequest(BaseModel):
    property_uid: uuid.UUID
    name: str = Field(min_length=1, max_length=120)
    code: str | None = Field(default=None, max_length=32)
    description: str | None = Field(default=None, max_length=2000)
    status: Literal["active", "inactive"] = "active"
    head_employee_uid: uuid.UUID | None = None


class DepartmentUpdateRequest(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=120)
    code: str | None = Field(default=None, max_length=32)
    description: str | None = Field(default=None, max_length=2000)
    status: Literal["active", "inactive"] | None = None
    # Sentinel-free: omit to leave unchanged, null to clear.
    head_employee_uid: uuid.UUID | None = None
    clear_head: bool = False


class DepartmentHeadAssignRequest(BaseModel):
    employee_uid: uuid.UUID


class DepartmentTransferRequest(BaseModel):
    property_uid: uuid.UUID
    employee_uids: list[uuid.UUID] = Field(min_length=1, max_length=200)
    to_department_uid: uuid.UUID | None = None
    reason: str | None = Field(default=None, max_length=2000)
    # Required whenever a transferred employee currently heads a
    # department: 'clear' removes the head, 'replace' installs
    # replacement_head_uid in their place.
    head_action: Literal["clear", "replace"] | None = None
    replacement_head_uid: uuid.UUID | None = None


class DepartmentHeadOut(BaseModel):
    employee_uid: uuid.UUID
    name: str


class DepartmentOut(BaseModel):
    department_uid: uuid.UUID
    property_uid: uuid.UUID
    name: str
    code: str | None
    description: str | None
    status: str
    is_system: bool
    head: DepartmentHeadOut | None
    employee_count: int
    active_employee_count: int
    created_at: datetime | None


class DepartmentEmployeeRow(BaseModel):
    employee_uid: uuid.UUID
    name: str
    email: str
    job_title: str | None
    status: str
    is_head: bool


class DepartmentDetailOut(DepartmentOut):
    employees: list[DepartmentEmployeeRow]
    heads_other_departments: list[str] = []


class DepartmentOverview(BaseModel):
    total_employees: int
    active_employees: int
    inactive_employees: int
    total_departments: int
    unassigned_employees: int
    departments_without_head: int
    avg_employees_per_department: float
    departments: list[DepartmentOut]


class DepartmentTransferOut(BaseModel):
    transfer_uid: uuid.UUID
    employee_uid: uuid.UUID
    employee_name: str | None
    from_department_uid: uuid.UUID | None
    from_department_name: str | None
    to_department_uid: uuid.UUID | None
    to_department_name: str | None
    reason: str | None
    changed_by_name: str | None
    created_at: datetime | None


class DepartmentTransferResult(BaseModel):
    transferred: int
    transfer_uids: list[uuid.UUID]
    head_decisions: list[str]
