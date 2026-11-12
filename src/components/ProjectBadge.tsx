import { projectBadge, projectColor, type ProjectInfo } from '../lib/projects';
import { cx } from '../lib/ui';

/**
 * Colored project badge. Solid for a project the user set; a dashed outline for a guessed one
 * (from the connection name or database).
 */
export default function ProjectBadge({ project, full = false, className }: { project: ProjectInfo; full?: boolean; className?: string }) {
  const color = projectColor(project.name);
  return (
    <span
      className={cx('inline-flex shrink-0 items-center justify-center rounded font-bold leading-none', project.auto && 'border border-dashed', className)}
      style={project.auto ? { borderColor: color, color } : { background: color, color: '#fff' }}
      title={`Project: ${project.name}${project.auto ? ' (guessed from the connection names or database; set it in the connection to keep it)' : ''}`}
      data-testid="project-badge"
    >
      {full ? project.name : projectBadge(project.name)}
    </span>
  );
}
