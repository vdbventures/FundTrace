'use client';

import { useEffect, useState } from 'react';

const WORDS = [
  'NVIDIA',
  'Bitcoin',
  'Shopify',
  'Loblaws',
  'Tesla',
  'Netflix',
  'Google',
  'RBC',
  'Amazon',
];

export default function AnimatedWord() {
  const [index, setIndex] = useState(0);
  const [visible, setVisible] = useState(true);

  useEffect(() => {
    const id = setInterval(() => {
      setVisible(false);
      setTimeout(() => {
        setIndex((i) => (i + 1) % WORDS.length);
        setVisible(true);
      }, 200);
    }, 2200);
    return () => clearInterval(id);
  }, []);

  return (
    <span
      key={index}
      className={`text-[#5B9FE8] ${visible ? 'word-enter' : 'opacity-0'}`}
      style={{ display: 'inline-block', minWidth: '4px' }}
    >
      {WORDS[index]}
    </span>
  );
}
