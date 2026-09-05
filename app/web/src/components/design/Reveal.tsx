/**
 * Reveal wrappers — staggered entrance for grids and lists, and the route
 * transition used by the shell. All collapse under reduced motion.
 */
import { motion } from 'motion/react';
import type { ReactNode } from 'react';
import { useListVariants, usePageVariants } from '../../lib/motion';

export interface RevealGroupProps {
  children: ReactNode;
  className?: string;
  as?: 'div' | 'ul' | 'section';
}

export function RevealGroup({ children, className, as = 'div' }: RevealGroupProps) {
  const { container } = useListVariants();
  const Component = motion[as];
  return (
    <Component variants={container} initial="initial" animate="enter" className={className}>
      {children}
    </Component>
  );
}

export interface RevealItemProps {
  children: ReactNode;
  className?: string;
  as?: 'div' | 'li' | 'article';
}

export function RevealItem({ children, className, as = 'div' }: RevealItemProps) {
  const { item } = useListVariants();
  const Component = motion[as];
  return (
    <Component variants={item} className={className}>
      {children}
    </Component>
  );
}

export function PageTransition({ children, className }: { children: ReactNode; className?: string }) {
  const variants = usePageVariants();
  return (
    <motion.div variants={variants} initial="initial" animate="enter" className={className}>
      {children}
    </motion.div>
  );
}
