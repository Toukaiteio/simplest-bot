export type SgsSkill = {
  name: string;
  desc: string;
  type?: string;
};

export type SgsCardData = {
  name: string;
  title: string;
  faction: "魏" | "蜀" | "吴" | "群" | "晋" | "神";
  hp: number;
  maxHp: number;
  armor: number;
  flavor: string;
  skills: SgsSkill[];
  backstory: string;
  designNotes?: string[];
  hideArt?: boolean;
  artImage?: string;
};

export type SkillValidation = {
  valid: boolean;
  issues: string[];
  suggestions: string[];
};
