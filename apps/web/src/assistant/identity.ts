/**
 * Who the assistant is on screen: one name, everywhere it appears (the sidebar tab, its panel, its
 * replies, its cursor and the call). The model behind it isn't named on screen.
 */
import { createContext } from 'react';

export const ASSISTANT_NAME = 'Remy';

/**
 * Class names that draw Remy's mark where only a class name fits, such as a Bryntum menu item or the
 * changelog's icons (styles/remy.css): her mark, or the spark alone where the ring would be too small.
 */
export const REMY_GLYPH = 'remy-glyph';
export const REMY_SPARK_GLYPH = 'remy-glyph is-spark';

/** The assistant's name, for the components inside its panel. */
export const AssistantName = createContext(ASSISTANT_NAME);
