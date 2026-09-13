import Link from "next/link";
import { MouseEventHandler, useMemo, useState } from "react";
import { MenuItem } from "../../api/getAllData";
import { describeNavItem, NavItemState, withNavCurrentClass } from "./active";

function LinkItemAtom(props: {
  item: MenuItem;
  state: NavItemState;
  variant: "underline" | "fill";
  onMouseEnter?: MouseEventHandler<HTMLLIElement>;
  onMouseLeave?: MouseEventHandler<HTMLLIElement>;
  children?: React.ReactNode;
  clsA?: string;
  cls?: string;
}) {
  const { item, state } = props;
  const cls = withNavCurrentClass(
    props.cls
      ? props.cls
      // ⚠️ 缩放**不能**加在这个 li 上：下划线是它的 :before 伪元素（`bottom: 2px`），
      // 一旦 li 被 scale(1.1)，整条横线会跟着往下移 ~2px、还会变宽变粗，
      // 于是「悬停的横线」和「当前页的横线」不在同一条水平线上。
      // 缩放交给里面的文字（group-hover），li 只当定位参照，横线就稳了。
      : `nav-item group dark:border-nav-dark  dark:transition-all ua`,
    state.current,
    props.variant
  );
  const clsA = `h-full flex items-center px-2 md:px-4 transform transition-transform duration-200 group-hover:scale-110 `;
  if (item.value.includes("http")) {
    return (
      <li
        onMouseEnter={props?.onMouseEnter}
        onMouseLeave={props?.onMouseLeave}
        key={item.id}
        className={cls}
      >
        <a
          className={props.clsA ? props.clsA : clsA}
          href={item.value}
          target="_blank"
        >
          {item.name}
        </a>
        {props?.children}
      </li>
    );
  } else {
    return (
      <li
        onMouseEnter={props?.onMouseEnter}
        onMouseLeave={props?.onMouseLeave}
        key={item.id}
        className={cls}
      >
        <Link
          href={item.value}
          style={{ height: "100%" }}
          aria-current={state.ariaCurrent}
        >
          <div className={props.clsA ? props.clsA : clsA}>{item.name}</div>
        </Link>
      </li>
    );
  }
}

function LinkItemWithChildren(props: {
  item: MenuItem;
  state: NavItemState;
}) {
  const { item, state } = props;
  const [hover, setHover] = useState(false);
  const [hoverSub, setHoverSub] = useState(false);
  const show = useMemo(() => {
    return hover || hoverSub;
  }, [hover, hoverSub]);

  return (
    <>
      <div className="h-full relative">
        <LinkItemAtom
          item={item}
          state={state}
          variant="underline"
          onMouseEnter={() => {
            setHover(true);
          }}
          onMouseLeave={() => {
            setHover(false);
          }}
        />

        <div
          className="card-shadow bg-white block transition-all dark:text-dark dark:bg-dark-1 dark:card-shadow-dark vanblog-nav-dropdown"
          style={{
            position: "absolute",
            minWidth: 100,
            top: 50,
            left: "-4px",
            transform: show ? "scale(100%)" : "scale(0)",
            zIndex: 80,
          }}
          onMouseEnter={() => {
            setHoverSub(true);
          }}
          onMouseLeave={() => {
            setHoverSub(false);
          }}
        >
          {item.children?.map((c, index) => {
            const childState =
              state.children?.[index] ?? describeNavItem(c, "", "fill");
            return (
              <LinkItemAtom
                item={c}
                state={childState}
                variant="fill"
                key={c.id}
                clsA={"h-full flex items-center px-2 md:px-4 py-2 "}
                cls={
                  "transition-all cursor-pointer flex items-center h-full hover:bg-gray-300 transition-all dark:hover:bg-dark-2  dark:text-dark dark:hover:text-dark-hover"
                }
              />
            );
          })}
        </div>
      </div>
    </>
  );
}

export default function (props: { item: MenuItem; currentPath: string }) {
  const { item, currentPath } = props;
  const state = describeNavItem(item, currentPath);
  if (!item.children) {
    return <LinkItemAtom item={item} state={state} variant="underline" />;
  } else {
    return <LinkItemWithChildren item={item} state={state} />;
  }
}
