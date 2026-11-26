from .conftest import join, make_user, new_org


def test_teacher_can_create_courses_for_org_members(admin):
    org_id = new_org(admin, "teacher-courses")
    teacher = make_user("teacher@teacher-courses.example.com")
    student = make_user("student@teacher-courses.example.com")
    stranger = make_user("stranger@teacher-courses.example.com")
    join(teacher, admin, org_id, "teacher")
    join(student, admin, org_id, "student")

    payload = {
        "title": "Réseaux locaux",
        "summary": "Découvrir les bases d'un LAN.",
        "duration_minutes": 45,
        "objectives": ["Identifier les équipements", "Configurer une adresse IP"],
        "lessons": [
            {
                "title": "Les équipements",
                "body": "Un réseau local relie des équipements.",
                "takeaway": "Le commutateur relie les hôtes.",
            }
        ],
    }

    created = teacher.post(f"/api/orgs/{org_id}/courses", json=payload)
    assert created.status_code == 201, created.text
    course = created.json()
    assert course["title"] == payload["title"]
    assert course["lessons"] == payload["lessons"]

    listed = student.get(f"/api/orgs/{org_id}/courses")
    assert listed.status_code == 200
    assert [item["id"] for item in listed.json()] == [course["id"]]
    assert student.post(f"/api/orgs/{org_id}/courses", json=payload).status_code == 403
    assert stranger.get(f"/api/orgs/{org_id}/courses").status_code == 404
    assert teacher.post(
        f"/api/orgs/{org_id}/courses",
        json={**payload, "lessons": []},
    ).status_code == 422
    assert teacher.post(
        f"/api/orgs/{org_id}/courses",
        json={**payload, "lessons": [{**payload["lessons"][0], "body": "   "}]},
    ).status_code == 422
