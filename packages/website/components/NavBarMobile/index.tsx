import { slide as Menu } from "react-burger-menu";
import LocaleSwitcher from "../LocaleSwitcher";
import useT from "../../hooks/useT";
import Link from "next/link";
import { useRouter } from "next/router";
import { useCallback } from "react";
import { MenuItem } from "../../api/getAllData";
import { describeNavItem, describeNavMenu, withNavCurrentClass } from "../NavBar/active";
export default function (props: {
  isOpen: boolean;
  setIsOpen: (i: boolean) => void;
  showAdminButton: "true" | "false";
  menus: MenuItem[];
}) {
  // 🔴 期 10 第五批：那一行「语言」小标题走 i18n 接缝
  const t = useT();
  const { asPath } = useRouter();
  const renderItem = useCallback(
    (item: MenuItem, state: ReturnType<typeof describeNavItem>, isSub?: boolean) => {
      const cls = withNavCurrentClass(
        "side-bar-item dark:border-dark-2 dark:hover:bg-dark-2",
        state.current,
        "sidebar"
      );
      if (item.value.includes("http")) {
        return (
          <li className={cls} key={item.id}>
            <a
              className={`w-full inline-block  ${isSub ? "px-6" : "px-4"}`}
              target="_blank"
              href={item.value}
            >
              {item.name}
            </a>
          </li>
        );
      } else {
        return (
          <li className={cls} key={item.id}>
            <Link href={item.value} aria-current={state.ariaCurrent}>
              <div className={`w-full inline-block  ${isSub ? "px-8" : "px-4"}`}>
                {item.name}
              </div>
            </Link>
          </li>
        );
      }
    },
    []
  );
  const renderLinks = useCallback(() => {
    const arr: any[] = [];
    const states = describeNavMenu(props.menus, asPath, "sidebar");
    props.menus.forEach((item, index) => {
      const state = states[index];
      arr.push(renderItem(item, state));
      if (item.children && item.children.length > 0) {
        item.children.forEach((i, childIndex) => {
          arr.push(
            renderItem(
              i,
              state.children?.[childIndex] ??
                describeNavItem(i, asPath, "sidebar"),
              true
            )
          );
        });
      }
    });
    return arr;
  }, [props, asPath, renderItem]);
  return (
    <>
      <div>
        <Menu
          id="nav-mobile"
          disableAutoFocus={true}
          customCrossIcon={false}
          customBurgerIcon={false}
          isOpen={props.isOpen}
          onStateChange={(state) => {
            if (state.isOpen) {
              // 要打开
              document.body.style.overflow = "hidden";
            } else {
              document.body.style.overflow = "auto";
            }

            props.setIsOpen(state.isOpen);
          }}
        >
          <ul
            onClick={() => {
              document.body.style.overflow = "auto";
              props.setIsOpen(false);
            }}
            className=" sm:flex h-full items-center  text-sm text-gray-600 hidden divide-y divide-dashed dark:text-dark "
          >
            {renderLinks()}
            {/* 🔴 期 10 第五批：移动端也要有语言切换按钮（否则手机访客切不了语种）。
                ⚠️ 放在 `renderLinks()` 之后、"管理后台"那一项之前 ⇒ 它是"站点级偏好"，
                与桌面端把它放在主题按钮旁边是同一个分类逻辑。 */}
            <li className="side-bar-item dark:border-dark-2 dark:hover:bg-dark-2" key={"locale-switch-phone-nav-btn"}>
              <span className="w-full inline-flex items-center justify-between px-4">
                <span className="text-sm">{t("locale.switcherShort", "语言")}</span>
                <LocaleSwitcher />
              </span>
            </li>
            {props.showAdminButton == "true" && (
              <li
                className="side-bar-item dark:border-dark-2 dark:hover:bg-dark-2"
                key={"rss-phone-nav-btn"}
              >
                <a
                  className="w-full inline-block px-4 "
                  target="_blank"
                  href={"/admin"}
                >
                  {"后台"}
                </a>
              </li>
            )}
          </ul>
        </Menu>
      </div>
    </>
  );
}
