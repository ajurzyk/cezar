import { clsx, type ClassValue } from 'clsx'
import { extendTailwindMerge } from 'tailwind-merge'

/* tailwind-merge ships Tailwind's stock scales, but our theme (styles/index.css) replaces the shadow
 * scale with xs/sm/md/modal. `shadow-modal` is not a name it knows, so it would classify it as a
 * shadow *color* and let it coexist with `shadow-md` instead of overriding it. Teaching it the extra
 * step keeps "last utility wins" true for shadows too.
 * The radius scale needs no extension: sm/md/lg/xl are all stock names.
 */
const twMerge = extendTailwindMerge({
  extend: { classGroups: { shadow: ['shadow-modal'] } },
})

/** Join conditional class names, letting later Tailwind utilities win over earlier conflicting ones. */
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}
