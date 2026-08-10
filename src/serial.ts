/**
 * 줄 세우기.
 *
 * MCP 클라이언트는 도구를 **병렬로** 부른다. 이 저장소에는 그게 문제가 되는
 * 자리가 두 종류 있다.
 *
 * ① 자원을 통째로 먹는 작업 — 렌더는 이미 이 방식으로 크롬 메모리를 1GB 에
 *    묶어뒀다(render/index.ts 주석). 업로드도 같은 성격이다: 파일당 10MB 를
 *    최대 60초간 들고 있는데 동시성 상한이 없으면 그대로 곱해진다.
 *
 * ② **읽고-합쳐-쓰는** 작업 — `velog_update_post` 는 기존 글을 읽어 생략 필드를
 *    채운 뒤 전체를 교체한다. 벨로그에는 버전도 ETag 도 없다. 같은 글에
 *    '제목=A' 와 '본문=B' 가 동시에 오면 둘 다 옛 값을 읽고, 나중에 쓴 쪽이
 *    앞선 변경을 지운다. 그런데 **둘 다 성공을 보고한다** — 사후 검증도 각자
 *    자기가 보낸 값과 맞춰보므로 통과한다. 사용자는 제목이 사라진 걸 모른다.
 *
 * ②는 같은 대상(글 id·프로필)끼리만 줄을 세우면 되므로 키를 받는다.
 * 다른 글끼리는 그대로 병렬로 돈다.
 *
 * ⚠️ 이건 **한 프로세스 안**에서만 유효하다. 사용자가 벨로그 웹에서 동시에
 *    고치는 것은 막을 수 없다 — 그건 벨로그가 버전을 주지 않는 한 방법이 없다.
 *    rate limiter 와 같은 한계이고, 같은 이유로 여기에 적어둔다.
 */

type Task<T> = () => Promise<T>;

/** 앞 작업이 끝나야 다음이 시작한다. 앞이 실패해도 줄은 이어진다. */
export function makeSerializer(): <T>(task: Task<T>) => Promise<T> {
	let queue: Promise<unknown> = Promise.resolve();
	return <T>(task: Task<T>): Promise<T> => {
		// 성공·실패 둘 다에 task 를 걸어 앞 작업의 실패가 줄을 끊지 않게 한다.
		const next = queue.then(task, task);
		queue = next.then(
			() => undefined,
			() => undefined,
		);
		return next;
	};
}

/**
 * 키가 같은 작업끼리만 줄을 세운다.
 *
 * ★ 다 쓴 키는 지운다. 안 지우면 글을 고칠 때마다 항목이 하나씩 쌓여
 *   오래 켜둔 서버에서 계속 자란다. 대기자 수를 세다가 0 이 되면 버린다.
 */
export interface KeyedSerializer {
	<T>(key: string, task: Task<T>): Promise<T>;
	/**
	 * 지금 살아 있는 줄 수. **테스트 전용.**
	 * 정리가 되는지 밖에서 볼 방법이 없으면 그 테스트는 거짓 초록이 된다 —
	 * 실제로 `lanes.delete()` 를 지워도 통과하는 테스트를 썼다가 코덱스에 잡혔다.
	 */
	laneCount(): number;
}

export function makeKeyedSerializer(): KeyedSerializer {
	const lanes = new Map<string, { tail: Promise<unknown>; waiting: number }>();

	const serialize = <T>(key: string, task: Task<T>): Promise<T> => {
		const lane = lanes.get(key) ?? { tail: Promise.resolve(), waiting: 0 };
		lanes.set(key, lane);
		lane.waiting++;

		const next = lane.tail.then(task, task);
		lane.tail = next.then(
			() => undefined,
			() => undefined,
		);
		// ★ 정리는 `next` 가 아니라 `lane.tail` 에 건다. next 는 호출자에게 그대로
		//   돌려주므로, 여기에 .then 을 걸면 호출자가 잡지 않은 거절이 하나 더 생긴다.
		void lane.tail.then(() => {
			lane.waiting--;
			if (lane.waiting === 0 && lanes.get(key) === lane) lanes.delete(key);
		});
		return next;
	};
	serialize.laneCount = (): number => lanes.size;
	return serialize;
}

/**
 * ★★ 쓰기 줄은 **저장소 전체에 하나뿐이어야 한다.**
 *
 * 처음엔 모듈마다 `makeKeyedSerializer()` 를 따로 만들었다. 그러면 키가 같아도
 * 줄이 다르다 — `velog_update_draft` 와 `velog_publish_draft` 를 같은 글에 동시에
 * 부르면 서로를 못 본다. 코덱스 교차검증에서 실제로 재현됐다: 같은 글의 사전
 * 조회가 겹쳤고(2), 발행 mutation 뒤에 초안 수정이 덮어써 최종 상태가 다시
 * 초안이 됐다. 도구 이름이 달라도 **대상이 같으면 같은 줄**이어야 한다.
 *
 * 키 규약: 글은 `post:<id>`, 새 글은 `post:new`, 프로필은 `profile`.
 */
export const serializeWrite = makeKeyedSerializer();

/** 테스트에서만 쓴다 — 줄이 실제로 비워지는지 본다. */
export const __testing = { makeKeyedSerializer, makeSerializer };
