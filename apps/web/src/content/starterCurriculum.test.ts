import { describe, expect, it } from 'vitest';
import { validateProject } from '@netlab/engine';
import { starterCourses, starterExercises } from './starterCurriculum';

describe('starter curriculum', () => {
  it('includes lessons with objectives and learning content', () => {
    expect(starterCourses).toHaveLength(3);
    for (const course of starterCourses) {
      expect(course.objectives.length).toBeGreaterThan(0);
      expect(course.lessons.length).toBeGreaterThan(0);
    }
  });

  it('provides a valid, pre-wired simulator project with instructions for every exercise', () => {
    expect(starterExercises).toHaveLength(3);
    for (const exercise of starterExercises) {
      const title = exercise.title.fr;
      const statement = exercise.statement.fr;
      const project = exercise.makeProject(title, statement);
      const validated = validateProject(project);
      expect(project.devices.length).toBeGreaterThan(0);
      expect(validated.links).toHaveLength(project.links.length);
      expect(validated.notes[0]?.text).toBe(statement);
    }
  });
});
