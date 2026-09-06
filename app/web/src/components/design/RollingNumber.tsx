/**
 * RollingNumber — odometer-style figure.
 *
 * Each digit is a vertical rail of 0–9 that springs to the current digit;
 * separators and units stay put. The full formatted value is kept in an
 * sr-only span so assistive technology (and tests) read one string, and
 * the rolling rails are `aria-hidden`. Under reduced motion the plain text
 * renders instead.
 */
import { motion } from 'motion/react';
import { SPRING_GENTLE, useReducedMotion } from '../../lib/motion';
import { cx } from './cx';

const DIGITS = ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9'];

export interface RollingNumberProps {
  /** Already formatted text, e.g. "1,204" or "71". */
  text: string;
  className?: string;
}

export function RollingNumber({ text, className }: RollingNumberProps) {
  const reduced = useReducedMotion();
  if (reduced) {
    return <span className={className}>{text}</span>;
  }
  const chars = Array.from(text);
  return (
    <span className={cx('inline-flex', className)}>
      <span className="sr-only">{text}</span>
      <span aria-hidden="true" className="inline-flex">
        {chars.map((char, index) => {
          const digit = DIGITS.indexOf(char);
          if (digit === -1) {
            return (
              <span key={`${index}-${char}`} className="inline-block">
                {char}
              </span>
            );
          }
          return (
            <span
              key={`${index}-d`}
              className="relative inline-block h-[1em] overflow-hidden tabular-nums"
              style={{ width: '0.62em' }}
            >
              <motion.span
                className="absolute left-0 top-0 flex flex-col"
                initial={false}
                animate={{ y: `-${digit}em` }}
                transition={SPRING_GENTLE}
              >
                {DIGITS.map((d) => (
                  <span key={d} className="block h-[1em] leading-none">
                    {d}
                  </span>
                ))}
              </motion.span>
            </span>
          );
        })}
      </span>
    </span>
  );
}
