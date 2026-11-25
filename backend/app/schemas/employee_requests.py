"""Wire schemas for the employee-registration approval surface.

Every field the mobile self-registration flow collected is echoed back
here so the deciding admin sees exactly what the applicant submitted.
The whole surface is super_admin-only — salary fields are therefore
always serialized (compensation never leaves this surface).
"""

import uuid
from datetime import datetime

from pydantic import BaseModel, Field


class EmployeeRequestApproveIn(BaseModel):
    # Requests are company-scoped until decided — the admin picks which
    # property (and optionally zone/shift) the employee lands in.
    property_uid: uuid.UUID
    zone_uid: uuid.UUID | None = None
    shift: str | None = Field(default=None, max_length=64)
    # Admin overrides — blank means "use what the applicant submitted".
    job_title: str | None = Field(default=None, max_length=255)
    department: str | None = Field(default=None, max_length=100)
    salary: str | None = Field(default=None, max_length=64)
    start_date: str | None = Field(default=None, max_length=10)


class EmployeeRequestRejectIn(BaseModel):
    reason: str | None = Field(default=None, max_length=500)


class EmployeeRequestOut(BaseModel):
    request_uid: str
    status: str
    full_name: str
    username: str
    email: str
    phone: str | None
    date_of_birth: str | None
    gender: str | None
    designation: str | None
    department: str | None
    employment_type: str | None
    joining_date: str | None
    reporting_manager: str | None
    salary: str | None
    salary_frequency: str | None
    reviewed_by_name: str | None
    reviewed_at: datetime | None
    rejection_reason: str | None
    created_employee_uid: str | None
    property_uid: str | None
    created_at: datetime


class EmployeeRequestListResponse(BaseModel):
    items: list[EmployeeRequestOut]
    total: int
    page: int
    limit: int


class PendingCountResponse(BaseModel):
    pending: int


class EmployeeRequestApproveResponse(BaseModel):
    request_uid: str
    status: str
    employee_uid: str
    user_uid: str
    username: str


class OrganizationCodeResponse(BaseModel):
    organization_code: str
